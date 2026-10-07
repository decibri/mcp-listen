'use strict';

// Deterministic coverage of the recording name, runnable on any platform
// with no microphone. Run by test/smoke.js; exits nonzero on any assertion
// failure.
//
// A capture must never replace a file that already exists. The name comes
// from Date.now(), so this suite fixes the clock, puts a file at the exact
// name the next capture will choose, and runs a real capture through
// lib/audio.js against a stubbed decibri. When no name is free, because
// every name the capture can try is taken or an explicit outputPath
// exists, the capture must return an error and leave every file as it
// was. os.tmpdir() is pointed at a private directory, so nothing outside
// it is read or written.

const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const { EventEmitter } = require('events');

// The startup sweep in lib/cleanup.js removes only names of this shape. A
// recording named any other way would never be removed.
const SWEEP_PATTERN = /^mcp-listen-\d+\.wav$/;

const FIXED_NOW = 1700000000000;

// A working default device: steady 100ms chunks of silence until stopped.
class FakeMicrophone extends EventEmitter {
  constructor() {
    super();
    this.isOpen = true;
    const chunk = Buffer.alloc(3200);
    this._timer = setInterval(() => this.emit('data', chunk), 2);
  }
  stop() {
    this.isOpen = false;
    clearInterval(this._timer);
    setImmediate(() => this.emit('end'));
  }
  static devices() {
    return [{
      index: 0, name: 'Stub Microphone', id: 'stub:mic',
      maxInputChannels: 1, defaultSampleRate: 16000, isDefault: true
    }];
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

const { captureAudio, MAX_NAME_ATTEMPTS } = require(path.join(__dirname, '..', 'lib', 'audio.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-listen-name-test-'));
const realTmpdir = os.tmpdir;
const realNow = Date.now;

(async () => {
  try {
    os.tmpdir = () => dir;
    Date.now = () => FIXED_NOW;

    // The name the capture will choose is already taken.
    const takenName = `mcp-listen-${FIXED_NOW}.wav`;
    const takenPath = path.join(dir, takenName);
    const takenBytes = Buffer.from('an existing file that a capture must not replace');
    fs.writeFileSync(takenPath, takenBytes);

    const res = await captureAudio({ durationMs: 500 });
    assert(!res.isError, `capture must succeed, got: ${res.content[0].text}`);
    const data = JSON.parse(res.content[0].text);
    const newName = path.basename(data.path);

    assert(fs.readFileSync(takenPath).equals(takenBytes),
      'the existing file must keep its exact bytes');
    // Same directory, so a different name cannot come from a write that
    // went somewhere else.
    assert.strictEqual(path.dirname(data.path), dir,
      `the recording must be written to the temporary directory, got: ${data.path}`);
    assert.notStrictEqual(newName, takenName,
      'the recording must go to a different name');
    assert(SWEEP_PATTERN.test(newName),
      `the recording name must match ${SWEEP_PATTERN}, got: ${newName}`);
    const stat = fs.statSync(data.path);
    assert.strictEqual(stat.size, 16044, `expected byte-exact 16044, got ${stat.size}`);

    console.log(`OK name-taken (${takenName} kept, recording written to ${newName}, ${stat.size} bytes)`);

    // Every name the capture can try is taken. The capture must return an
    // error, add no file, and leave each existing file as it was. A fresh
    // directory makes the file count exact.
    const fullDir = path.join(dir, 'all-taken');
    fs.mkdirSync(fullDir);
    os.tmpdir = () => fullDir;
    const existing = new Map();
    for (let i = 0; i < MAX_NAME_ATTEMPTS; i++) {
      const name = `mcp-listen-${FIXED_NOW + i}.wav`;
      const bytes = Buffer.from(`existing file ${i}`);
      fs.writeFileSync(path.join(fullDir, name), bytes);
      existing.set(name, bytes);
    }

    const full = await captureAudio({ durationMs: 500 });
    assert.strictEqual(full.isError, true,
      `capture must fail when every name is taken, got: ${full.content[0].text}`);
    assert.deepStrictEqual(fs.readdirSync(fullDir).sort(), [...existing.keys()].sort(),
      'a capture with no free name must not add a file');
    for (const [name, bytes] of existing) {
      assert(fs.readFileSync(path.join(fullDir, name)).equals(bytes),
        `${name} must keep its exact bytes`);
    }
    console.log(`OK all-names-taken (${MAX_NAME_ATTEMPTS} names taken, error returned, no file added or changed)`);

    // An explicit outputPath has no second name to try. If a file is
    // already there, the capture must return an error and leave the file
    // as it was.
    const explicitPath = path.join(dir, 'explicit.wav');
    const explicitBytes = Buffer.from('an existing file at an explicit outputPath');
    fs.writeFileSync(explicitPath, explicitBytes);

    const clash = await captureAudio({ durationMs: 500, outputPath: explicitPath });
    assert.strictEqual(clash.isError, true,
      `capture must fail when outputPath exists, got: ${clash.content[0].text}`);
    assert(fs.readFileSync(explicitPath).equals(explicitBytes),
      'the file at outputPath must keep its exact bytes');
    console.log('OK explicit-path-taken (error returned, file unchanged)');
  } finally {
    os.tmpdir = realTmpdir;
    Date.now = realNow;
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
