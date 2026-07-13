'use strict';

// Deterministic simulations of the machine states behind the default-path
// guard in lib/audio.js, runnable on any platform. decibri is stubbed in
// the module cache before lib/audio.js loads, so captureAudio exercises its
// real logic against a controlled device list. Run by test/smoke.js; exits
// nonzero on any assertion failure.
//
//   node stub-device-states.js no-default
//     Devices exist, none is flagged default, and the default-path capture
//     fails via the 'error' event before delivering any data (the ALSA
//     phantom-default failure shape). Must produce the actionable
//     no-usable-default error with the original error embedded, and no WAV.
//
//   node stub-device-states.js no-default-throw
//     Same device list, but the default-path constructor throws
//     synchronously (the shape Windows/macOS produce when the host reports
//     no default). Must translate identically through the catch path.
//
//   node stub-device-states.js null-only
//     The only device is the ALSA null device. The default path must be
//     refused outright, whether the device argument is omitted or null
//     (decibri maps JSON null to the system default, and MCP clients send
//     it). Explicit selection of the null device by id must still capture
//     byte-exactly: refusing a deliberate act would break real diagnostic
//     use (and this suite's own by-id test).
//
//   node stub-device-states.js mid-capture
//     No flagged default, but the default capture delivers audio and THEN
//     fails. The device demonstrably worked, so the error must be reported
//     as-is, NOT translated into the no-usable-default message.

const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const { EventEmitter } = require('events');

const MODES = ['no-default', 'no-default-throw', 'null-only', 'mid-capture'];
const mode = process.argv[2];
if (!MODES.includes(mode)) {
  console.error(`Unknown mode: ${mode}. Expected one of: ${MODES.join(', ')}`);
  process.exit(2);
}

const NULL_DEVICE = {
  index: 0,
  name: 'Discard all samples (playback) or generate zero samples (capture)',
  id: 'alsa:null',
  maxInputChannels: 2,
  defaultSampleRate: 44100,
  isDefault: false
};

const REAL_DEVICES_NO_DEFAULT = [
  { index: 0, name: 'Microphone A', id: 'alsa:front:CARD=A', maxInputChannels: 2, defaultSampleRate: 48000, isDefault: false },
  { index: 1, name: 'Microphone B', id: 'alsa:front:CARD=B', maxInputChannels: 2, defaultSampleRate: 48000, isDefault: false }
];

class FakeMicrophone extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.isOpen = true;
    if (opts.device === undefined || opts.device === null) {
      if (mode === 'no-default-throw') {
        // The synchronous failure shape: the host reports no default at
        // all and construction itself fails.
        throw new Error('No microphone found. Check system audio input settings.');
      }
      if (mode === 'mid-capture') {
        // Deliver real audio, then fail. Both from one macrotask so the
        // ordering is deterministic: data first, then the error.
        setImmediate(() => {
          this.emit('data', Buffer.alloc(3200));
          this.isOpen = false;
          this.emit('error', new Error('Device disconnected (simulated)'));
        });
        return;
      }
      // 'no-default': mirror the real ALSA failure shape. Construction
      // succeeds; the stream errors before delivering a single byte, with
      // the raw message a real headless machine produces.
      setImmediate(() => {
        this.isOpen = false;
        this.emit('error', new Error(
          'Failed to enumerate devices: The requested device is no longer available. For example, it has been unplugged.'
        ));
      });
    } else {
      // Explicit selection: deliver zero samples like the real null
      // device, in steady chunks, until stopped.
      const chunk = Buffer.alloc(3200);
      this._timer = setInterval(() => this.emit('data', chunk), 10);
    }
  }
  stop() {
    this.isOpen = false;
    clearInterval(this._timer);
    setImmediate(() => this.emit('end'));
  }
  static devices() {
    return mode === 'null-only' ? [NULL_DEVICE] : REAL_DEVICES_NO_DEFAULT;
  }
}

// Install the stub before lib/audio.js resolves 'decibri'.
const decibriPath = require.resolve('decibri');
require.cache[decibriPath] = {
  id: decibriPath,
  filename: decibriPath,
  loaded: true,
  exports: { Microphone: FakeMicrophone }
};

const { captureAudio } = require(path.join(__dirname, '..', 'lib', 'audio.js'));

const MARKER = 'no usable default input device';

function assertActionable(text, { expectUnderlying }) {
  assert(text.includes(MARKER), `expected "${MARKER}" in: ${text}`);
  assert(text.includes('list_audio_devices'), `error must point at list_audio_devices: ${text}`);
  assert(!/\.wav/i.test(text), `error must not reference a WAV file: ${text}`);
  if (expectUnderlying) {
    assert(text.includes('Underlying error:'), `original error must be embedded: ${text}`);
    assert(text.includes('2 input device(s) found'), `device count must be reported: ${text}`);
  } else {
    assert(text.includes('ALSA null device'), `refusal must name the null device: ${text}`);
    assert(!text.includes('Underlying error:'), `preemptive refusal has no underlying error: ${text}`);
  }
}

(async () => {
  // Default-path capture, device omitted.
  const res = await captureAudio({ durationMs: 500 });
  assert.strictEqual(res.isError, true, 'default-path capture must fail');
  const text = res.content[0].text;

  if (mode === 'mid-capture') {
    // Audio arrived before the failure: the device worked, and the real
    // error must survive untranslated.
    assert(text.startsWith('Microphone error during recording:'), `expected the raw mid-capture error, got: ${text}`);
    assert(!text.includes(MARKER), `mid-capture failure must not be translated: ${text}`);
  } else {
    assertActionable(text, { expectUnderlying: mode !== 'null-only' });
  }

  if (mode === 'null-only') {
    // device: null means the default path too (decibri maps JSON null to
    // the system default); the refusal must cover it.
    const nullArg = await captureAudio({ durationMs: 500, device: null });
    assert.strictEqual(nullArg.isError, true, 'device: null must be refused like an omitted device');
    assertActionable(nullArg.content[0].text, { expectUnderlying: false });

    // Explicit selection of the null device is a deliberate act and must
    // still capture byte-exactly.
    const outputPath = path.join(os.tmpdir(), `mcp-listen-stub-${process.pid}.wav`);
    const explicit = await captureAudio({ durationMs: 500, device: 'alsa:null', outputPath });
    assert(!explicit.isError, `explicit null selection must succeed, got: ${explicit.content[0].text}`);
    const stat = fs.statSync(outputPath);
    try { fs.unlinkSync(outputPath); } catch {}
    assert.strictEqual(stat.size, 16044, `expected byte-exact 16044, got ${stat.size}`);
  }

  console.log(`OK ${mode}`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
