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
const { MIN_DURATION_MS, MAX_DURATION_MS, MIN_SILENCE_MS, MAX_SILENCE_MS } = require('./validate');

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BIT_DEPTH = 16;

// Silero speech-probability threshold for the silence-stopped mode: a chunk
// scoring at or above it is speech, below is not. This is the model's own
// documented default. Deliberately not exposed as a tool argument: it is a
// model-tuning knob with no intuitive unit, unlike silence_ms, which is time.
const VAD_THRESHOLD = 0.5;

// Backstop for a silence-stopped capture where speech never starts: after
// this much DELIVERED AUDIO with no chunk scoring at or above the threshold,
// the capture stops and the result carries speech_detected: false. Measured
// in audio, not wall clock, like every stop decision in this file. It is a
// backstop, not a tunable, so it is not exposed. When the duration_ms
// ceiling is lower, the ceiling fires first and the result still reports
// speech_detected: false.
const NO_SPEECH_TIMEOUT_MS = 10000;
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

// True while a silence-stopped capture is inside the asynchronous
// Microphone.open() (the Silero model load runs off the event loop there,
// taking up to a few hundred milliseconds cold). During that window no mic
// object exists yet, so the activeMic guard alone would let a second
// capture start; this flag closes the gap.
let capturePending = false;

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

function captureAudio({ durationMs = 5000, device, outputPath, stopOnSilence = false, silenceMs = 1000 } = {}) {
  return new Promise((resolve) => {
    // decibri maps a JSON null device to the system default, and MCP
    // clients do send device: null for "no preference" (the SDK does not
    // enforce the tool's input schema). Fold null into the omitted-device
    // path so the default-path guards below apply to it as well.
    if (device === null) device = undefined;

    // Validate duration. The server validates tool arguments before this
    // module is reached; this guard is the module's own boundary, for
    // direct callers. Number.isInteger is the load-bearing part: a bare
    // range comparison passes NaN, numeric strings, and objects, because
    // every comparison with NaN is false and strings coerce.
    if (!Number.isInteger(durationMs) || durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
      return resolve({
        content: [{ type: 'text', text: `Error: duration_ms must be an integer between ${MIN_DURATION_MS} and ${MAX_DURATION_MS}. Got: ${durationMs}` }],
        isError: true
      });
    }

    // Same boundary guards for the silence-stopped mode's arguments.
    // typeof, not truthiness, so 0, 1, and strings cannot select a mode.
    if (typeof stopOnSilence !== 'boolean') {
      return resolve({
        content: [{ type: 'text', text: `Error: stop_on_silence must be a boolean. Got: ${stopOnSilence}` }],
        isError: true
      });
    }
    if (stopOnSilence && (!Number.isInteger(silenceMs) || silenceMs < MIN_SILENCE_MS || silenceMs > MAX_SILENCE_MS)) {
      return resolve({
        content: [{ type: 'text', text: `Error: silence_ms must be an integer between ${MIN_SILENCE_MS} and ${MAX_SILENCE_MS}. Got: ${silenceMs}` }],
        isError: true
      });
    }

    // Reject concurrent captures. capturePending covers the window where a
    // silence-stopped capture is still inside the asynchronous open and no
    // mic object exists yet.
    if (capturePending || (activeMic && activeMic.isOpen)) {
      return resolve({
        content: [{ type: 'text', text: 'Error: Recording already in progress. Wait for the current recording to finish.' }],
        isError: true
      });
    }

    // Refuse a default-path capture that could only record silence. Scoped
    // narrowly: only when no device was requested AND the null device is
    // all the machine has. If enumeration fails here, fall through and let
    // the capture attempt produce the real error. Runs before any mic is
    // constructed, so a refused silence-stopped capture never loads the
    // VAD model.
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
    // The silence-stopped mode adds Silero VAD and nothing else: no
    // conditioning option is ever set here, so the delivered samples are
    // identical in both modes (VAD annotates the stream, it never gates or
    // alters it).
    const micOptions = { sampleRate: SAMPLE_RATE, channels: CHANNELS };
    if (device !== undefined) {
      micOptions.device = typeof device === 'string' ? { id: device } : device;
    }
    if (stopOnSilence) {
      micOptions.vad = 'silero';
    }

    // Everything downstream of construction is shared by both modes and is
    // wired by attach() below. The construction itself branches: the fixed
    // path keeps the synchronous constructor (no model to load, and the
    // path must stay byte-for-byte what it was), while the silence path
    // uses the asynchronous factory because the synchronous constructor
    // loads the Silero model inline and would block the event loop for up
    // to a few hundred milliseconds on a cold cache.
    function constructionFailure(err) {
      if (device === undefined) {
        const translated = translateDefaultPathFailure(err);
        if (translated) return translated;
      }
      return {
        content: [{ type: 'text', text: `Error opening microphone: ${err.message}` }],
        isError: true
      };
    }

    if (stopOnSilence) {
      capturePending = true;
      Microphone.open(micOptions).then(
        (mic) => {
          capturePending = false;
          attach(mic);
        },
        (err) => {
          capturePending = false;
          resolve(constructionFailure(err));
        }
      );
    } else {
      let mic;
      try {
        mic = new Microphone(micOptions);
      } catch (err) {
        return resolve(constructionFailure(err));
      }
      attach(mic);
    }

    function attach(mic) {
      activeMic = mic;

      // Stop on bytes delivered, not wall clock. Stream startup time varies
      // by machine and would otherwise be silently deducted from the capture,
      // and audio arrives in whole buffers, so a wall-clock stop also loses
      // whatever fraction of a buffer is in flight. Counting bytes makes the
      // payload exact for the requested duration. The silence-stopped mode
      // keeps the same discipline: its hangover and no-speech backstop are
      // measured in delivered bytes too, never timers, so the stop chunk is
      // an exact function of the audio and its per-chunk scores.
      const bytesPerSample = BIT_DEPTH / 8;
      const targetBytes =
        Math.round((durationMs * SAMPLE_RATE) / 1000) * CHANNELS * bytesPerSample;
      const silenceTargetBytes =
        Math.round((silenceMs * SAMPLE_RATE) / 1000) * CHANNELS * bytesPerSample;
      const noSpeechTargetBytes =
        Math.round((NO_SPEECH_TIMEOUT_MS * SAMPLE_RATE) / 1000) * CHANNELS * bytesPerSample;

      const chunks = [];
      let receivedBytes = 0;
      let stopping = false;
      let settled = false;
      let safetyTimer = null;

      // Silence-stopped state. stoppedBy records which condition ended the
      // capture deliberately; it stays null in fixed mode and when a
      // silence-mode stream dies underneath us, which is how the 'end'
      // handler tells a legitimate short capture from a truncated one.
      let speechSeen = false;
      let silentBytes = 0;
      let stoppedBy = null;

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

        if (stopOnSilence) {
          // decibri's wrapper updates vadScore AFTER it pushes the chunk,
          // and 'data' handlers run synchronously inside that push, so the
          // score read here belongs to the PREVIOUS chunk (0 before the
          // first). The lag is exactly one chunk (~100ms at the default
          // buffer size), deterministic, and absorbed by the hangover:
          // every transition is seen one chunk late, so a capture runs at
          // most one chunk past the ideal cut. The stub suite reproduces
          // this read-after-push ordering exactly; do not "fix" the lag
          // here without changing the stub to match.
          const score = mic.vadScore;
          if (speechSeen) {
            if (score >= VAD_THRESHOLD) {
              // Speech resumed inside the hangover: the pause was a pause,
              // not the end of the utterance. Start the hangover over.
              silentBytes = 0;
            } else {
              silentBytes += chunk.length;
              if (silentBytes >= silenceTargetBytes) {
                stoppedBy = 'silence';
                return stopMic();
              }
            }
          } else if (score >= VAD_THRESHOLD) {
            speechSeen = true;
          } else if (receivedBytes >= noSpeechTargetBytes) {
            stoppedBy = 'no_speech_timeout';
            return stopMic();
          }
        }

        if (receivedBytes >= targetBytes) {
          // In silence mode the duration is a ceiling; label the stop so
          // the caller can tell "the speaker never paused" from "the
          // speaker finished". Fixed mode reports nothing extra.
          if (stopOnSilence) stoppedBy = 'ceiling';
          stopMic();
        }
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

        // 'end' should only follow a deliberate stop; anything shorter with
        // no stop recorded means the stream ended underneath us, and a
        // short WAV must not be presented as a successful capture. In fixed
        // mode the only deliberate stop is the target being met, so the
        // condition is unchanged from what it always was; in silence mode a
        // short payload with stoppedBy set is the entire point of the mode.
        if (pcm.length < targetBytes && stoppedBy === null) {
          return finish({
            content: [{ type: 'text', text: `Error: capture ended early. Received ${pcm.length} of ${targetBytes} bytes.` }],
            isError: true
          });
        }

        const wav = createWavBuffer(pcm, SAMPLE_RATE, CHANNELS, BIT_DEPTH);
        const filepath = outputPath || path.join(os.tmpdir(), `mcp-listen-${Date.now()}.wav`);

        // The capture is complete, so the stall guard's job is over. Clear
        // it before the asynchronous write: otherwise it could fire during
        // the write and race a stall error against the successful result.
        clearTimeout(safetyTimer);

        // The fixed-mode result is byte-for-byte what it always was: same
        // keys, same order, same values. The silence mode reports the
        // actual captured duration (whole chunks make the division exact)
        // plus how the capture ended, so a caller can distinguish "the
        // speaker finished" / "the ceiling cut them off" / "nobody spoke"
        // without inspecting audio. No speech is a reported outcome, not an
        // error: the WAV is returned either way.
        const result = {
          path: filepath,
          duration_ms: stopOnSilence
            ? Math.round((pcm.length * 1000) / (SAMPLE_RATE * CHANNELS * bytesPerSample))
            : durationMs,
          sample_rate: SAMPLE_RATE,
          channels: CHANNELS,
          size_bytes: wav.length
        };
        if (stopOnSilence) {
          result.stopped_by = stoppedBy;
          result.speech_detected = speechSeen;
        }

        fs.promises.writeFile(filepath, wav).then(
          () => finish({
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }]
          }),
          (err) => finish({
            content: [{ type: 'text', text: `Error writing WAV file: ${err.message}` }],
            isError: true
          })
        );
      });

      // Stall guard only: capture normally stops when targetBytes arrive
      // (or, in silence mode, when a silence-machine condition fires, all
      // of which happen at or before the ceiling). Wall-clock budget =
      // requested duration (delivery is real time) plus a generous margin
      // for stream startup. This is failure detection for a stream that
      // stalls or never starts, not a stop mechanism, which is why it is
      // the one legitimate timer in this function.
      safetyTimer = setTimeout(() => {
        stopMic();
        finish({
          content: [{ type: 'text', text: `Error: capture stalled. Received ${receivedBytes} of ${targetBytes} bytes within ${durationMs + SAFETY_MARGIN_MS}ms.` }],
          isError: true
        });
      }, durationMs + SAFETY_MARGIN_MS);
    }
  });
}

module.exports = { listDevices, captureAudio, getActiveMic };
