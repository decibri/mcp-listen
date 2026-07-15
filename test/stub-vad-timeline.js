'use strict';

// Deterministic coverage of the silence-stopped capture mode, runnable on
// any platform with no microphone. Run by test/smoke.js; exits nonzero on
// any assertion failure.
//
// The layering this suite implements: decibri pins audio-to-score (its own
// golden Silero fixtures, upstream); THIS suite pins score-to-bytes. The
// real Silero model cannot be driven offline from JS (decibri exposes no
// standalone VAD), so the model is not what is under test here. What is
// under test is every decision mcp-listen makes on top of the scores: the
// speech/silence state machine, the hangover, the no-speech backstop, the
// ceiling, and the exact byte count each of them produces. All of it is
// measured in delivered audio, never wall clock, which is why this suite
// can run compressed (chunks arrive every couple of milliseconds, not every
// 100ms) and still produce identical byte counts: the "10 second" backstop
// firing here in well under a second IS the proof that no timer is
// involved in any stop decision.
//
// The one subtle part, mirrored deliberately: decibri's wrapper updates
// vadScore AFTER it pushes each chunk, and 'data' handlers run
// synchronously inside that push, so production code reading mic.vadScore
// in a 'data' handler sees the PREVIOUS chunk's score (0 before the
// first). FakeVadMicrophone reproduces that exact read-after-push ordering
// (emit first, then update vadScore). Every expected byte count below is
// computed WITH the one-chunk lag; if the capture layer ever starts
// reading fresh scores, or the stub ever updates the score before
// emitting, the stop chunk moves and these assertions fail. That is the
// point of them.

const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const { EventEmitter } = require('events');

// One chunk mirrors decibri's default delivery: 1600 frames of int16 mono
// at 16kHz = 3200 bytes = 100ms of audio.
const CHUNK_BYTES = 3200;
const CHUNK_MS = 100;
const CHUNK = Buffer.alloc(CHUNK_BYTES);
const WAV_HEADER_BYTES = 44;

// Reconfigured per scenario; the fake reads it at call time so one require
// of lib/audio.js serves every scenario.
const current = {
  devices: [{
    index: 0,
    name: 'Stub Microphone',
    id: 'stub:mic',
    maxInputChannels: 1,
    defaultSampleRate: 16000,
    isDefault: true
  }],
  scores: [],
  constructorCalls: 0,
  openCalls: 0,
  lastOptions: null
};

const NULL_DEVICE = {
  index: 0,
  name: 'Discard all samples (playback) or generate zero samples (capture)',
  id: 'alsa:null',
  maxInputChannels: 2,
  defaultSampleRate: 44100,
  isDefault: false
};

class FakeVadMicrophone extends EventEmitter {
  constructor(opts = {}) {
    super();
    current.constructorCalls++;
    current.lastOptions = opts;
    this.isOpen = true;
    // Matches the real wrapper: 0 before the first chunk is processed.
    this.vadScore = 0;

    let i = 0;
    // Compressed delivery: the interval only sequences the event loop, it
    // is not part of any stop decision (those are all byte-counted).
    this._timer = setInterval(() => {
      if (!this.isOpen) return;
      const idx = i++;
      // Hold the final score forever so a scenario that under-specifies
      // its timeline still terminates through the ceiling or the backstop
      // instead of hanging.
      const score = current.scores[Math.min(idx, current.scores.length - 1)] ?? 0;
      // Read-after-push ordering, the load-bearing part: 'data' handlers
      // run synchronously inside this emit and must see the PREVIOUS
      // score, exactly as with the real wrapper.
      this.emit('data', CHUNK);
      this.vadScore = score;
    }, 2);
  }

  stop() {
    this.isOpen = false;
    clearInterval(this._timer);
    setImmediate(() => {
      // One straggler chunk that crossed the boundary after stop(), like a
      // real flushed tail. The capture layer must drop it, or every
      // byte-exact assertion in this suite moves by one chunk.
      this.emit('data', CHUNK);
      this.emit('end');
    });
  }

  static async open(opts) {
    current.openCalls++;
    return new FakeVadMicrophone(opts);
  }

  static devices() {
    return current.devices;
  }
}

// Install the stub before lib/audio.js resolves 'decibri'.
const decibriPath = require.resolve('decibri');
require.cache[decibriPath] = {
  id: decibriPath,
  filename: decibriPath,
  loaded: true,
  exports: { Microphone: FakeVadMicrophone }
};

const { captureAudio } = require(path.join(__dirname, '..', 'lib', 'audio.js'));

// Run one silence-mode capture against a scripted score timeline and
// assert the exact terminal state: which condition stopped it, whether
// speech was seen, the payload byte count, the reported duration, and a
// fully correct WAV header. `chunks` is the expected number of delivered
// chunks INCLUDING the one whose handler made the stop decision.
async function runScenario(name, { scores, silenceMs, durationMs, chunks, stoppedBy, speechDetected }) {
  current.scores = scores;
  current.lastOptions = null;
  const outputPath = path.join(os.tmpdir(), `mcp-listen-vadstub-${process.pid}-${name}.wav`);

  const res = await captureAudio({ durationMs, stopOnSilence: true, silenceMs, outputPath });
  assert(!res.isError, `${name}: capture must succeed, got: ${res.content[0].text}`);

  // The silence mode must add Silero VAD and must not touch anything else:
  // no conditioning option may ever be set by this feature.
  assert.strictEqual(current.lastOptions.vad, 'silero', `${name}: vad: 'silero' must be requested`);
  for (const key of ['dcRemoval', 'denoise', 'highpass', 'agc', 'limiter']) {
    assert.strictEqual(current.lastOptions[key], undefined, `${name}: ${key} must not be set`);
  }

  const data = JSON.parse(res.content[0].text);
  const expectedPcm = chunks * CHUNK_BYTES;
  const expectedSize = WAV_HEADER_BYTES + expectedPcm;

  assert.strictEqual(data.stopped_by, stoppedBy, `${name}: stopped_by`);
  assert.strictEqual(data.speech_detected, speechDetected, `${name}: speech_detected`);
  assert.strictEqual(data.duration_ms, chunks * CHUNK_MS, `${name}: duration_ms`);
  assert.strictEqual(data.size_bytes, expectedSize, `${name}: size_bytes`);

  // duration_ms is the ACTUAL captured length (whole delivered chunks), never
  // the ceiling echoed back. When the no-speech backstop stops a capture whose
  // ceiling is higher, the two genuinely differ, and the reported duration must
  // be the captured length, not the ceiling. This pins that a no-speech result
  // does not misreport the ceiling as a duration.
  if (stoppedBy === 'no_speech_timeout') {
    assert(durationMs > data.duration_ms,
      `${name}: this scenario must exercise a ceiling above the captured length`);
    assert.notStrictEqual(data.duration_ms, durationMs,
      `${name}: no-speech duration_ms must be the captured length, not the ceiling`);
  }

  const stat = fs.statSync(outputPath);
  assert.strictEqual(stat.size, expectedSize,
    `${name}: expected byte-exact ${expectedSize} (${chunks} chunks), got ${stat.size}`);

  // The header must be exactly right regardless of the payload length:
  // format fields plus a data-chunk size that matches the actual payload.
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  const fd = fs.openSync(outputPath, 'r');
  fs.readSync(fd, header, 0, WAV_HEADER_BYTES, 0);
  fs.closeSync(fd);
  assert.strictEqual(header.toString('ascii', 0, 4), 'RIFF', `${name}: RIFF magic`);
  assert.strictEqual(header.readUInt16LE(22), 1, `${name}: header channels`);
  assert.strictEqual(header.readUInt32LE(24), 16000, `${name}: header sample rate`);
  assert.strictEqual(header.readUInt16LE(34), 16, `${name}: header bit depth`);
  assert.strictEqual(header.readUInt32LE(40), expectedPcm, `${name}: header data size`);

  try { fs.unlinkSync(outputPath); } catch {}
  console.log(`OK ${name} (${chunks} chunks, ${expectedSize} bytes, ${stoppedBy})`);
}

function repeat(score, n) {
  return new Array(n).fill(score);
}

(async () => {
  // Chunk-by-chunk arithmetic for the expected stop chunks, worked once so
  // the numbers below are auditable. Handler N reads the score of chunk
  // N-1 (the one-chunk lag). With scores = 5 silence, 10 speech, then
  // silence, and silence_ms 1000 (10 chunks of hangover):
  //   handlers 1..6  read scores 0, s1..s5           -> no speech yet
  //   handler  7     reads s6 = speech               -> speechSeen
  //   handlers 8..16 read s7..s15 = speech           -> hangover reset
  //   handlers 17..26 read s16..s25 = silence        -> hangover fills
  //   handler  26    accumulates the 10th silent chunk -> stop
  // Payload = 26 chunks = 83200 bytes; WAV = 83244.

  // 1. Speech then silence: stops at the exact chunk the hangover fills.
  await runScenario('speech-then-silence', {
    scores: [...repeat(0.1, 5), ...repeat(0.9, 10), ...repeat(0.05, 40)],
    silenceMs: 1000,
    durationMs: 10000,
    chunks: 26,
    stoppedBy: 'silence',
    speechDetected: true
  });

  // 2. No speech at all: the 10s backstop fires on delivered audio (here
  // in well under a second of wall time), returns the WAV with
  // speech_detected: false. 100 chunks = 10000ms exactly.
  await runScenario('no-speech-backstop', {
    scores: repeat(0.05, 120),
    silenceMs: 1000,
    durationMs: 15000,
    chunks: 100,
    stoppedBy: 'no_speech_timeout',
    speechDetected: false
  });

  // 3. No speech with a ceiling below the backstop: the ceiling fires
  // first and the result still reports that nobody spoke.
  await runScenario('no-speech-under-ceiling', {
    scores: repeat(0.05, 40),
    silenceMs: 1000,
    durationMs: 3000,
    chunks: 30,
    stoppedBy: 'ceiling',
    speechDetected: false
  });

  // 4. Speech that never pauses: the ceiling stops it, byte-exact at the
  // ceiling, same count-and-trim as the fixed path (64044 at 2000ms, the
  // same number the fixed-path smoke assertion pins).
  await runScenario('never-pauses', {
    scores: repeat(0.9, 30),
    silenceMs: 1000,
    durationMs: 2000,
    chunks: 20,
    stoppedBy: 'ceiling',
    speechDetected: true
  });

  // 5/6. silence_ms variations on the same timeline as scenario 1: a
  // shorter hangover stops 5 chunks earlier, a longer one 10 later. Pins
  // that silence_ms is honoured in audio time.
  await runScenario('short-hangover', {
    scores: [...repeat(0.1, 5), ...repeat(0.9, 10), ...repeat(0.05, 40)],
    silenceMs: 500,
    durationMs: 10000,
    chunks: 21,
    stoppedBy: 'silence',
    speechDetected: true
  });
  await runScenario('long-hangover', {
    scores: [...repeat(0.1, 5), ...repeat(0.9, 10), ...repeat(0.05, 40)],
    silenceMs: 2000,
    durationMs: 10000,
    chunks: 36,
    stoppedBy: 'silence',
    speechDetected: true
  });

  // 7. The door slam: one speech-scored chunk, then silence. Yields a
  // short WAV with speech_detected: true, no crash. The known limitation
  // ships as a visible outcome; this pins its exact shape.
  await runScenario('door-slam', {
    scores: [...repeat(0.1, 3), 0.9, ...repeat(0.05, 30)],
    silenceMs: 1000,
    durationMs: 10000,
    chunks: 15,
    stoppedBy: 'silence',
    speechDetected: true
  });

  // 8. Speech resumes inside the hangover: the counter must reset. Without
  // the reset this timeline stops at chunk 21 (67244 bytes); with it, at
  // chunk 26 (83244). The byte count discriminates.
  await runScenario('resume-during-hangover', {
    scores: [...repeat(0.9, 5), ...repeat(0.1, 5), ...repeat(0.9, 5), ...repeat(0.05, 40)],
    silenceMs: 1000,
    durationMs: 10000,
    chunks: 26,
    stoppedBy: 'silence',
    speechDetected: true
  });

  // 9. Guard ordering: on a machine whose only device is the ALSA null
  // device, a default-path silence-stopped capture is refused exactly like
  // a fixed one, BEFORE any microphone (and therefore any VAD model) is
  // constructed.
  current.devices = [NULL_DEVICE];
  current.constructorCalls = 0;
  current.openCalls = 0;
  const refused = await captureAudio({ durationMs: 5000, stopOnSilence: true, silenceMs: 1000 });
  assert.strictEqual(refused.isError, true, 'null-only: silence-mode capture must be refused');
  assert(refused.content[0].text.includes('no usable default input device'),
    `null-only: expected the actionable no-default error, got: ${refused.content[0].text}`);
  assert.strictEqual(current.constructorCalls, 0, 'null-only: refusal must precede mic construction');
  assert.strictEqual(current.openCalls, 0, 'null-only: refusal must precede Microphone.open');
  current.devices = [{
    index: 0, name: 'Stub Microphone', id: 'stub:mic',
    maxInputChannels: 1, defaultSampleRate: 16000, isDefault: true
  }];
  console.log('OK refusal-precedes-vad');

  // 10. The fixed path through the same fake: byte-exact at 500ms and the
  // result JSON carries EXACTLY the legacy keys in the legacy order, with
  // no vad option requested. This pins, at the result level, that
  // stop_on_silence: absent means byte-for-byte the old behaviour.
  current.scores = repeat(0.9, 40); // irrelevant to fixed mode, deliberately noisy
  current.lastOptions = null;
  const fixedPath = path.join(os.tmpdir(), `mcp-listen-vadstub-${process.pid}-fixed.wav`);
  const fixed = await captureAudio({ durationMs: 500, outputPath: fixedPath });
  assert(!fixed.isError, `fixed: capture must succeed, got: ${fixed.content[0].text}`);
  assert.strictEqual(current.lastOptions.vad, undefined, 'fixed: no vad option may be passed');
  const fixedData = JSON.parse(fixed.content[0].text);
  assert.deepStrictEqual(Object.keys(fixedData),
    ['path', 'duration_ms', 'sample_rate', 'channels', 'size_bytes'],
    'fixed: result keys must be exactly the legacy set, in the legacy order');
  const fixedStat = fs.statSync(fixedPath);
  try { fs.unlinkSync(fixedPath); } catch {}
  assert.strictEqual(fixedStat.size, 16044, `fixed: expected byte-exact 16044, got ${fixedStat.size}`);
  console.log('OK fixed-mode-unchanged (16044 bytes)');

  // 11. voice_query's no-speech result, deterministically. voice_query lives
  // in index.js and its capture step runs through the same stubbed decibri,
  // so requiring it here (index.js does not start the server when required)
  // drives the real pipeline: an all-silence timeline makes captureAudio hit
  // the no-speech backstop, voice_query short-circuits before whisper, and
  // must return a NON-ERROR result whose machine-readable contract is
  // speech_detected: false, aligned field-for-field with what capture_audio
  // reports for the identical event. No whisper model or Ollama daemon is
  // touched: the no-speech path returns before transcription.
  const { voiceQuery } = require(path.join(__dirname, '..', 'index.js'));

  // A capture_audio no-speech result to compare shapes against: same stubbed
  // silence, run directly through captureAudio with a ceiling above the 10s
  // backstop so it stops on no_speech_timeout.
  current.scores = repeat(0.05, 130);
  const capNoSpeech = await captureAudio({ durationMs: 15000, stopOnSilence: true, silenceMs: 1000 });
  const capData = JSON.parse(capNoSpeech.content[0].text);
  try { fs.unlinkSync(capData.path); } catch {}
  assert(!capNoSpeech.isError, 'capture_audio no-speech must be a non-error result');
  assert.strictEqual(capData.speech_detected, false, 'capture_audio: speech_detected false');
  assert.strictEqual(capData.stopped_by, 'no_speech_timeout', 'capture_audio: stopped_by');

  // voice_query over the same silence: non-error, speech_detected: false, and
  // the shared no-speech fields identical to capture_audio's.
  current.scores = repeat(0.05, 130);
  const vq = await voiceQuery({});
  assert(!vq.isError, `voice_query no-speech must be non-error, got: ${vq.content[0].text}`);
  const vqData = JSON.parse(vq.content[0].text);
  assert.strictEqual(vqData.speech_detected, false, 'voice_query: speech_detected must be false');
  assert.strictEqual(vqData.stopped_by, capData.stopped_by,
    'voice_query and capture_audio must report the same stopped_by for no-speech');
  assert.strictEqual(vqData.speech_detected, capData.speech_detected,
    'voice_query and capture_audio must report the same speech_detected for no-speech');
  // Pipeline-specific fields: the steps that did not run are explicitly null,
  // so a caller sees there is no transcription rather than an empty string it
  // might try to use.
  assert.strictEqual(vqData.transcription, null, 'voice_query: transcription must be null');
  assert.strictEqual(vqData.response, null, 'voice_query: response must be null');
  // The prose message is a human hint, not the contract; assert only that one
  // exists, never its wording.
  assert.strictEqual(typeof vqData.message, 'string', 'voice_query: a human message should exist');
  console.log('OK voicequery-no-speech-aligned');

  console.log('OK vad-timeline');
})().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
