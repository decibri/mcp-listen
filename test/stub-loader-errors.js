'use strict';

// Deterministic coverage of the optional-dependency load paths in
// lib/transcribe.js and lib/llm.js, runnable on any platform with no
// whisper model, no Ollama daemon, and no microphone. Run by
// test/smoke.js; exits nonzero on any assertion failure.
//
// The require of each optional dependency is intercepted below
// Module._load, so each case controls exactly how the load fails (or what
// it returns) and the modules under test execute their real logic. This
// pins the distinction the error messages must draw:
//
//   - The package itself is missing (MODULE_NOT_FOUND naming the package):
//     the message says "not installed" and gives the install command.
//   - The package is present but fails to load (a missing native library,
//     a MODULE_NOT_FOUND for one of its internal files): the message says
//     "failed to load" and surfaces the underlying error text, and it must
//     NOT tell the user to install something that is already installed.
//
// The two messages being different IS the bug being pinned: every failure
// mode used to collapse into the "not installed" message, sending a user
// with a broken native library to an install command that changes nothing.

const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const Module = require('module');

const TRANSCRIBE = path.join(__dirname, '..', 'lib', 'transcribe.js');
const LLM = path.join(__dirname, '..', 'lib', 'llm.js');

// request -> thunk returning the module exports (or throwing the load
// error). Anything not listed resolves normally.
const interceptors = new Map();

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (interceptors.has(request)) {
    return interceptors.get(request)();
  }
  return originalLoad.call(this, request, parent, isMain);
};

// The modules under test capture the load outcome at require time, so
// every case needs a fresh copy.
function freshRequire(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function moduleNotFound(request) {
  const err = new Error(`Cannot find module '${request}'`);
  err.code = 'MODULE_NOT_FOUND';
  return err;
}

(async () => {
  // ── transcribe: addon genuinely not installed ─────────────────────
  const notInstalledErr = moduleNotFound('@kutalia/whisper-node-addon');
  interceptors.set('@kutalia/whisper-node-addon', () => { throw notInstalledErr; });
  let { transcribe } = freshRequire(TRANSCRIBE);
  const notInstalled = await transcribe({ filePath: 'irrelevant.wav' });
  assert(notInstalled.error, 'not-installed: expected an error result');
  assert(notInstalled.error.includes('is not installed'),
    `not-installed: message must say not installed: ${notInstalled.error}`);
  assert(notInstalled.error.includes('npm install @kutalia/whisper-node-addon'),
    `not-installed: message must give the install command: ${notInstalled.error}`);
  assert.strictEqual(notInstalled.cause, notInstalledErr,
    'not-installed: original error must be preserved as cause');

  // ── transcribe: addon installed but its native library fails ──────
  const loadErr = new Error(
    'Failed to load native addon: Error: libwhisper.so.1: ' +
    'cannot open shared object file: No such file or directory'
  );
  interceptors.set('@kutalia/whisper-node-addon', () => { throw loadErr; });
  ({ transcribe } = freshRequire(TRANSCRIBE));
  const loadFailed = await transcribe({ filePath: 'irrelevant.wav' });
  assert(loadFailed.error, 'load-failure: expected an error result');
  assert(loadFailed.error.includes('failed to load'),
    `load-failure: message must name a load failure: ${loadFailed.error}`);
  assert(loadFailed.error.includes('libwhisper.so.1: cannot open shared object file'),
    `load-failure: underlying error text must be surfaced: ${loadFailed.error}`);
  assert(!loadFailed.error.includes('npm install'),
    `load-failure: must not tell the user to install an installed addon: ${loadFailed.error}`);
  assert.strictEqual(loadFailed.cause, loadErr,
    'load-failure: original error must be preserved as cause');

  // The whole bug: these two states used to produce one message.
  assert.notStrictEqual(notInstalled.error, loadFailed.error,
    'the not-installed and load-failure messages must differ');

  // ── transcribe: MODULE_NOT_FOUND for a file INSIDE the addon ──────
  // The addon is present but broken, so this is a load failure, not an
  // install gap, even though the error code says MODULE_NOT_FOUND.
  interceptors.set('@kutalia/whisper-node-addon',
    () => { throw moduleNotFound('./build/Release/whisper-addon.node'); });
  ({ transcribe } = freshRequire(TRANSCRIBE));
  const innerNotFound = await transcribe({ filePath: 'irrelevant.wav' });
  assert(innerNotFound.error.includes('failed to load'),
    `inner MODULE_NOT_FOUND must be reported as a load failure: ${innerNotFound.error}`);
  assert(innerNotFound.error.includes('./build/Release/whisper-addon.node'),
    `inner MODULE_NOT_FOUND must surface the missing file: ${innerNotFound.error}`);

  // ── transcribe: addon loads, model file missing ────────────────────
  const fakeWhisper = {
    transcribe: async () => ({ transcription: [[0, 1, ' Hello'], [1, 2, 'world ']] })
  };
  interceptors.set('@kutalia/whisper-node-addon', () => fakeWhisper);
  ({ transcribe } = freshRequire(TRANSCRIBE));
  const missingModel = path.join(os.tmpdir(), `mcp-listen-no-such-model-${process.pid}.bin`);
  const noModel = await transcribe({ filePath: 'irrelevant.wav', modelPath: missingModel });
  assert(noModel.error && noModel.error.includes('not found'),
    `missing model must produce the download guidance: ${noModel.error}`);

  // ── transcribe: full success path through segment mapping ─────────
  const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-listen-stub-model-'));
  const modelFile = path.join(modelDir, 'ggml-base.en.bin');
  fs.writeFileSync(modelFile, 'stub');
  try {
    const ok = await transcribe({ filePath: 'irrelevant.wav', modelPath: modelFile });
    assert.strictEqual(ok.transcription, 'Hello world',
      `segment arrays must join and trim: ${JSON.stringify(ok)}`);

    // String segments are accepted too.
    fakeWhisper.transcribe = async () => ({ transcription: ['one', 'two'] });
    const strings = await transcribe({ filePath: 'irrelevant.wav', modelPath: modelFile });
    assert.strictEqual(strings.transcription, 'one two');

    // An unexpected response shape is an error, not a crash.
    fakeWhisper.transcribe = async () => ({ nothing: true });
    const badShape = await transcribe({ filePath: 'irrelevant.wav', modelPath: modelFile });
    assert(badShape.error && badShape.error.includes('Unexpected whisper response format'),
      `unexpected shape must be reported: ${JSON.stringify(badShape)}`);

    // A throw from the addon during transcription is reported with its text.
    fakeWhisper.transcribe = async () => { throw new Error('decode blew up'); };
    const threw = await transcribe({ filePath: 'irrelevant.wav', modelPath: modelFile });
    assert(threw.error && threw.error.includes('Transcription failed: decode blew up'),
      `transcription throw must surface the error: ${JSON.stringify(threw)}`);
  } finally {
    fs.rmSync(modelDir, { recursive: true, force: true });
  }

  // ── llm: ollama genuinely not installed ───────────────────────────
  const ollamaMissing = moduleNotFound('ollama');
  interceptors.set('ollama', () => { throw ollamaMissing; });
  let { chat } = freshRequire(LLM);
  const ollamaNotInstalled = await chat({ text: 'hi' });
  assert(ollamaNotInstalled.error.includes('is not installed'),
    `ollama not-installed: ${ollamaNotInstalled.error}`);
  assert(ollamaNotInstalled.error.includes('npm install ollama'),
    `ollama not-installed must give the install command: ${ollamaNotInstalled.error}`);
  assert.strictEqual(ollamaNotInstalled.cause, ollamaMissing);

  // ── llm: ollama installed but fails to load ───────────────────────
  const ollamaLoadErr = new Error('unexpected token in dist/index.cjs (simulated)');
  interceptors.set('ollama', () => { throw ollamaLoadErr; });
  ({ chat } = freshRequire(LLM));
  const ollamaLoadFailed = await chat({ text: 'hi' });
  assert(ollamaLoadFailed.error.includes('failed to load'),
    `ollama load failure must be named: ${ollamaLoadFailed.error}`);
  assert(ollamaLoadFailed.error.includes('unexpected token in dist/index.cjs'),
    `ollama load failure must surface the underlying error: ${ollamaLoadFailed.error}`);
  assert(!ollamaLoadFailed.error.includes('npm install'),
    `ollama load failure must not advise reinstalling: ${ollamaLoadFailed.error}`);
  assert.notStrictEqual(ollamaNotInstalled.error, ollamaLoadFailed.error,
    'the ollama not-installed and load-failure messages must differ');

  console.log('OK loader-errors');
})().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
