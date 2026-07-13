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

// The ALSA null device exists on every Linux machine with alsa-lib
// installed, hardware or not, and its documented function is to generate
// zero samples. When it is the only input device, a default-path capture
// can "succeed" while recording pure digital silence: a valid WAV, a green
// pipeline, an empty transcript, and no error anywhere to debug from. For
// a speech tool that is worse than failing, so the default path refuses in
// that state. Hard-coding this id is a deliberate trade: the identifier is
// defined by alsa-lib's own configuration and is stable, decibri's own
// deployment guidance matches on it, and the alternative is silently
// transcribing nothing on every headless Linux host. Explicit selection of
// the null device by index or id is a deliberate act and still works.
const ALSA_NULL_DEVICE_ID = 'alsa:null';

let activeMic = null;

function getActiveMic() {
  return activeMic;
}

// The error result for a default-path capture that cannot work: no usable
// default input device. Used both when the refusal is preemptive (the only
// device is the ALSA null device) and when a failed capture is translated
// after the fact (no enumerated device is flagged default).
function noUsableDefaultResult(deviceCount, detail) {
  const text =
    `Error: no usable default input device on this system. ` +
    `${deviceCount} input device(s) found. ` +
    `Pass 'device' with an index or id from list_audio_devices to select one explicitly.` +
    (detail ? ` ${detail}` : '');
  return { content: [{ type: 'text', text }], isError: true };
}

// Translate a failed default-path capture into the actionable error when
// the machine reports no default input device. Gated on observable machine
// state, not on the error's message text: start-path errors carry no
// decibri code, and message matching would break on any upstream wording
// change. If enumeration itself fails, return null and let the original
// error stand.
function translateDefaultPathFailure(err) {
  try {
    const devices = Microphone.devices();
    // Zero devices is a different state: the original error ("No
    // microphone found...") is already the right guidance, and telling
    // the user to select from an empty list would be advice they cannot
    // follow. Translate only when there is something to select.
    if (devices.length > 0 && !devices.some((d) => d.isDefault)) {
      return noUsableDefaultResult(devices.length, `(Underlying error: ${err.message})`);
    }
  } catch {}
  return null;
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
    // decibri maps a JSON null device to the system default, and MCP
    // clients do send device: null for "no preference" (the SDK does not
    // enforce the tool's input schema). Fold null into the omitted-device
    // path so the default-path guards below apply to it as well.
    if (device === null) device = undefined;

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

    // Refuse a default-path capture that could only record silence. Scoped
    // narrowly: only when no device was requested AND the null device is
    // all the machine has. If enumeration fails here, fall through and let
    // the capture attempt produce the real error.
    if (device === undefined) {
      try {
        const devices = Microphone.devices();
        if (devices.length > 0 && devices.every((d) => d.id === ALSA_NULL_DEVICE_ID)) {
          return resolve(noUsableDefaultResult(
            devices.length,
            'The only input device on this system is the ALSA null device, which generates silence instead of capturing audio.'
          ));
        }
      } catch {}
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
      if (device === undefined) {
        const translated = translateDefaultPathFailure(err);
        if (translated) return resolve(translated);
      }
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
      // On ALSA the default device is an unprobed phantom: construction
      // succeeds and the first open fails here, before any data arrives,
      // with an error about an unplugged device that was never plugged in.
      // A default-path failure with zero bytes delivered is an open
      // failure, not a mid-capture loss, so it is eligible for the
      // no-usable-default translation; once any audio has arrived the
      // device demonstrably worked and the error is reported as-is.
      if (device === undefined && receivedBytes === 0) {
        const translated = translateDefaultPathFailure(err);
        if (translated) return finish(translated);
      }
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
