'use strict';

// decibri ships prebuilt binaries for a fixed set of targets and has no
// source-build fallback. Off that set its loader fails with advice about
// npm optional-dependency bugs and deleting the lockfile, which cannot
// help when the binary is simply not published. Translate that into a
// statement the user can act on, and keep the loader's error as the cause.
// A load failure on a supported target is a different problem (for
// example a missing system library), so it is rethrown untouched.
const PREBUILT_TARGETS = new Set(['win32-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']);
const SUPPORTED_PLATFORMS =
  'Windows x64, macOS Apple silicon (arm64), Linux x64 (glibc), Linux arm64 (glibc)';

let Microphone;
try {
  ({ Microphone } = require('decibri'));
} catch (err) {
  let target = `${process.platform}-${process.arch}`;
  let published = PREBUILT_TARGETS.has(target);
  // The Linux binaries are glibc-only. Mirror the loader's musl detection
  // (musl reports no glibcVersionRuntime) so Alpine gets the actionable
  // message too, not the loader's reinstall advice.
  if (published && process.platform === 'linux') {
    try {
      process.report.excludeNetwork = true;
      if (!process.report.getReport().header.glibcVersionRuntime) {
        published = false;
        target += ' (musl)';
      }
    } catch {
      // Cannot tell which libc this is; assume glibc and let the loader
      // error stand rather than mislabel a supported machine.
    }
  }
  if (published) throw err;
  const reason = target === 'darwin-x64'
    ? 'Intel Mac is not supported: Apple has discontinued the platform and no decibri binary is published for it.'
    : `No decibri binary is published for ${target}.`;
  throw new Error(
    `mcp-listen cannot run on ${target}. ${reason} ` +
    `Supported platforms: ${SUPPORTED_PLATFORMS}. ` +
    `Underlying loader error: ${err.message}`,
    { cause: err }
  );
}

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createWavBuffer } = require('./wav');

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BIT_DEPTH = 16;
const MIN_DURATION_MS = 100;
const MAX_DURATION_MS = 30000;
// Stall guard, not the stop mechanism. Capture stops when the requested
// duration of PCM has arrived; this margin only bounds how long we wait
// for a stream that stalls or never starts delivering. Stream startup
// alone can take the better part of a second on a slow machine, so the
// margin is generous.
const SAFETY_MARGIN_MS = 4000;

let activeMic = null;

function getActiveMic() {
  return activeMic;
}

function listDevices() {
  try {
    const devices = Microphone.devices();
    if (devices.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ devices: [], message: 'No audio input devices found. Connect a microphone and try again.' }, null, 2) }]
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(devices, null, 2) }]
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error listing audio devices: ${err.message}` }],
      isError: true
    };
  }
}

function captureAudio({ durationMs = 5000, device, outputPath } = {}) {
  return new Promise((resolve) => {
    // Validate duration
    if (durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
      return resolve({
        content: [{ type: 'text', text: `Error: duration_ms must be between ${MIN_DURATION_MS} and ${MAX_DURATION_MS}. Got: ${durationMs}` }],
        isError: true
      });
    }

    // Reject concurrent captures
    if (activeMic && activeMic.isOpen) {
      return resolve({
        content: [{ type: 'text', text: 'Error: Recording already in progress. Wait for the current recording to finish.' }],
        isError: true
      });
    }

    // Build mic options. A number selects by positional index. A string is
    // always treated as the stable id from list_audio_devices, never as a
    // device name: two devices can share a name (real hardware does this),
    // so name selection is ambiguous by construction and not exposed.
    const micOptions = { sampleRate: SAMPLE_RATE, channels: CHANNELS };
    if (device !== undefined) {
      micOptions.device = typeof device === 'string' ? { id: device } : device;
    }

    // Create microphone (throws synchronously if device invalid or no mic)
    let mic;
    try {
      mic = new Microphone(micOptions);
    } catch (err) {
      return resolve({
        content: [{ type: 'text', text: `Error opening microphone: ${err.message}` }],
        isError: true
      });
    }

    activeMic = mic;

    // Stop on bytes delivered, not wall clock. Stream startup time varies
    // by machine and would otherwise be silently deducted from the capture,
    // and audio arrives in whole buffers, so a wall-clock stop also loses
    // whatever fraction of a buffer is in flight. Counting bytes makes the
    // payload exact for the requested duration.
    const bytesPerSample = BIT_DEPTH / 8;
    const targetBytes =
      Math.round((durationMs * SAMPLE_RATE) / 1000) * CHANNELS * bytesPerSample;

    const chunks = [];
    let receivedBytes = 0;
    let stopping = false;
    let settled = false;
    let safetyTimer = null;

    function finish(result) {
      if (settled) return;
      settled = true;
      activeMic = null;
      clearTimeout(safetyTimer);
      resolve(result);
    }

    function stopMic() {
      if (stopping) return;
      stopping = true;
      try { if (mic.isOpen) mic.stop(); } catch {}
    }

    mic.on('data', (chunk) => {
      // A chunk can cross the native thread boundary after stop() has been
      // called. Once stopping, late chunks are dropped so the payload
      // cannot change under the trim below.
      if (stopping) return;
      chunks.push(chunk);
      receivedBytes += chunk.length;
      if (receivedBytes >= targetBytes) stopMic();
    });

    mic.on('error', (err) => {
      stopMic();
      finish({
        content: [{ type: 'text', text: `Microphone error during recording: ${err.message}` }],
        isError: true
      });
    });

    mic.on('end', () => {
      // Trim the whole-buffer overshoot so the payload is byte-exact.
      let pcm = Buffer.concat(chunks);
      if (pcm.length > targetBytes) pcm = pcm.subarray(0, targetBytes);

      // 'end' should only follow a target-met stop; anything shorter means
      // the stream ended underneath us, and a short WAV must not be
      // presented as a successful capture of the requested duration.
      if (pcm.length < targetBytes) {
        return finish({
          content: [{ type: 'text', text: `Error: capture ended early. Received ${pcm.length} of ${targetBytes} bytes.` }],
          isError: true
        });
      }

      const wav = createWavBuffer(pcm, SAMPLE_RATE, CHANNELS, BIT_DEPTH);
      const filepath = outputPath || path.join(os.tmpdir(), `mcp-listen-${Date.now()}.wav`);

      try {
        fs.writeFileSync(filepath, wav);
      } catch (err) {
        return finish({
          content: [{ type: 'text', text: `Error writing WAV file: ${err.message}` }],
          isError: true
        });
      }

      finish({
        content: [{
          type: 'text',
          text: JSON.stringify({
            path: filepath,
            duration_ms: durationMs,
            sample_rate: SAMPLE_RATE,
            channels: CHANNELS,
            size_bytes: wav.length
          }, null, 2)
        }]
      });
    });

    // Stall guard only: capture normally stops when targetBytes arrive.
    // Wall-clock budget = requested duration (delivery is real time) plus
    // a generous margin for stream startup.
    safetyTimer = setTimeout(() => {
      stopMic();
      finish({
        content: [{ type: 'text', text: `Error: capture stalled. Received ${receivedBytes} of ${targetBytes} bytes within ${durationMs + SAFETY_MARGIN_MS}ms.` }],
        isError: true
      });
    }, durationMs + SAFETY_MARGIN_MS);
  });
}

module.exports = { listDevices, captureAudio, getActiveMic };
