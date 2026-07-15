'use strict';

// Deterministic coverage of voice_query's five-way no-answer contract and
// the filler-detection correctness fix, runnable on any platform with no
// microphone, no whisper model, and no Ollama daemon. Run by test/smoke.js;
// exits nonzero on any assertion failure.
//
// index.js's capture, transcription, and LLM layers are replaced in the
// module cache before index.js loads, so voiceQuery runs its real
// decomposition logic against scripted results. index.js starts its server
// only under `require.main === module`, so requiring it here loads voiceQuery
// without a transport. The one load-bearing assertion is that a filler-only
// transcription NEVER reaches the LLM: that is the live hallucination bug
// this fix closes.
//
// The contract under test (structured fields are the contract; prose is not):
//   Event 1  no speech            -> non-error, speech_detected: false, transcription: null
//   Event 2  speech, no words     -> non-error, speech_detected: true,  transcription: null
//   Event 3  whisper failure      -> isError, surfaces the real cause
//   Event 4  ollama unavailable   -> isError, surfaces the real cause
//   Event 5  ollama empty         -> isError, transcription attached
//   Normal   words + answer       -> non-error, transcription + response
//
// Error-event assertions check that the dependency's REAL cause propagated
// (a propagation test), never the wording of a message this tool authored.
// Our own prose (events 2 and 5) is asserted only to exist.

const path = require('path');
const assert = require('assert');

const REPO = path.join(__dirname, '..');
const FAKE_WAV = path.join(require('os').tmpdir(), `mcp-listen-vqstub-${process.pid}-nonexistent.wav`);

function stub(relPath, exports) {
  const resolved = require.resolve(path.join(REPO, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Controls, reset per scenario by run().
let captureData;      // parsed into the capture result captureAudio returns
let transcribeResult; // what the stubbed transcribe() returns
let chatResult;       // what the stubbed chat() returns
let chatCalls;        // how many times chat() was invoked

stub('lib/audio.js', {
  captureAudio: async () => ({ content: [{ type: 'text', text: JSON.stringify(captureData) }] }),
  listDevices: () => ({ content: [{ type: 'text', text: '[]' }] }),
  getActiveMic: () => null
});
stub('lib/transcribe.js', { transcribe: async () => transcribeResult });
stub('lib/llm.js', {
  chat: async () => { chatCalls++; return chatResult; }
});

const { voiceQuery } = require(path.join(REPO, 'index.js'));

function parse(text) {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function run({ cap, transcription, chat }) {
  captureData = Object.assign({ path: FAKE_WAV }, cap);
  transcribeResult = transcription;
  chatResult = chat;
  chatCalls = 0;
  const res = await voiceQuery({});
  const data = res.content && res.content[0] ? parse(res.content[0].text) : null;
  return { res, data, isError: !!res.isError, chatCalls };
}

// A response the LLM stub would return if it were ever (wrongly) called on
// filler. Its presence in a result would prove the hallucination path is open.
const POISON = 'HALLUCINATED ANSWER TO A MARKER';

(async () => {
  // ── Filler detection: every filler-only transcription is event 2 and
  // never reaches the LLM. This is the correctness fix. ────────────────────
  const fillers = [
    '[BLANK_AUDIO]',
    '[ MUSIC ]',
    '[Blank_Audio]',        // mixed case
    '[SOUND]',
    '[ NOISE ]',
    '(silence)',
    '(wind blowing)',
    '   ',                  // whitespace only
    '...',                  // punctuation only
    '♪♪',        // musical notes
    '[BLANK_AUDIO] [BLANK_AUDIO]',
    '- [BLANK_AUDIO]'
  ];
  for (const filler of fillers) {
    const r = await run({
      cap: { speech_detected: true, stopped_by: 'silence' },
      transcription: { transcription: filler },
      chat: { response: POISON, model: 'llama3.2' }
    });
    assert(!r.isError, `filler ${JSON.stringify(filler)} must be non-error`);
    assert.strictEqual(r.data.speech_detected, true, `filler ${JSON.stringify(filler)}: speech_detected true`);
    assert.strictEqual(r.data.transcription, null, `filler ${JSON.stringify(filler)}: transcription null`);
    assert.strictEqual(r.data.response, null, `filler ${JSON.stringify(filler)}: response null`);
    assert.strictEqual(typeof r.data.message, 'string', `filler ${JSON.stringify(filler)}: a message exists`);
    assert.strictEqual(r.chatCalls, 0, `filler ${JSON.stringify(filler)} MUST NOT reach the LLM`);
    assert(!JSON.stringify(r.data).includes(POISON), `filler ${JSON.stringify(filler)} must not carry an LLM answer`);
  }
  console.log(`OK filler-detection (${fillers.length} markers routed to event 2, LLM never called)`);

  // ── Over-strip guard: a real transcription that merely CONTAINS a marker
  // is treated as real and reaches the LLM. Guards against discarding
  // genuine speech. ────────────────────────────────────────────────────────
  const reals = [
    'I heard a [beep] sound',
    'The code is [REDACTED] today',
    'the meeting is at (about) 3 pm',
    'hello',
    '你好',        // non-Latin script (Chinese "hello")
    '42'
  ];
  for (const real of reals) {
    const r = await run({
      cap: { speech_detected: true, stopped_by: 'silence' },
      transcription: { transcription: real },
      chat: { response: '5432', model: 'llama3.2' }
    });
    assert(!r.isError, `real ${JSON.stringify(real)} must be non-error`);
    assert.strictEqual(r.chatCalls, 1, `real ${JSON.stringify(real)} MUST reach the LLM`);
    assert.strictEqual(r.data.transcription, real, `real ${JSON.stringify(real)}: transcription passed through`);
    assert.strictEqual(r.data.response, '5432', `real ${JSON.stringify(real)}: answer returned`);
  }
  console.log(`OK over-strip-guard (${reals.length} real transcriptions reach the LLM)`);

  // ── Event 1 vs event 2: distinguishable by speech_detected. ──────────────
  const e1 = await run({
    cap: { speech_detected: false, stopped_by: 'no_speech_timeout' },
    transcription: { transcription: 'UNUSED' },
    chat: { response: POISON, model: 'llama3.2' }
  });
  assert(!e1.isError, 'event 1 must be non-error');
  assert.strictEqual(e1.data.speech_detected, false, 'event 1: speech_detected false');
  assert.strictEqual(e1.data.transcription, null, 'event 1: transcription null');
  assert.strictEqual(e1.chatCalls, 0, 'event 1 short-circuits before transcription and the LLM');

  const e2 = await run({
    cap: { speech_detected: true, stopped_by: 'silence' },
    transcription: { transcription: '[BLANK_AUDIO]' },
    chat: { response: POISON, model: 'llama3.2' }
  });
  assert(!e2.isError, 'event 2 must be non-error');
  assert.strictEqual(e2.data.speech_detected, true, 'event 2: speech_detected true');
  assert.strictEqual(e2.data.transcription, null, 'event 2: transcription null');
  assert.notStrictEqual(e1.data.speech_detected, e2.data.speech_detected,
    'events 1 and 2 must be distinguishable by speech_detected');
  console.log('OK event1-vs-event2 (distinguished by speech_detected)');

  // In a fixed-window capture no VAD ran, so speech_detected is honestly
  // absent on event 2 rather than asserted true.
  const e2fixed = await run({
    cap: { stopped_by: undefined },   // no speech_detected key
    transcription: { transcription: '   ' },
    chat: { response: POISON, model: 'llama3.2' }
  });
  assert(!e2fixed.isError, 'event 2 (fixed mode) must be non-error');
  assert.strictEqual(e2fixed.data.transcription, null, 'event 2 (fixed mode): transcription null');
  assert(!('speech_detected' in e2fixed.data) || e2fixed.data.speech_detected === undefined,
    'event 2 (fixed mode): speech_detected absent, not fabricated');
  assert.strictEqual(e2fixed.chatCalls, 0, 'event 2 (fixed mode) must not reach the LLM');
  console.log('OK event2-fixed-mode (speech_detected honestly absent)');

  // ── Event 3: whisper failure -> isError, real cause surfaced, no LLM. ────
  const e3 = await run({
    cap: { speech_detected: true, stopped_by: 'silence' },
    transcription: { error: 'Transcription failed: decode blew up' },
    chat: { response: POISON, model: 'llama3.2' }
  });
  assert(e3.isError, 'event 3 must be isError');
  assert(e3.res.content[0].text.includes('Transcription failed: decode blew up'),
    'event 3 must surface the real transcription failure');
  assert.strictEqual(e3.chatCalls, 0, 'event 3 must not reach the LLM');

  // ── Event 4: ollama failure -> isError, real cause surfaced. ─────────────
  const e4 = await run({
    cap: { speech_detected: true, stopped_by: 'silence' },
    transcription: { transcription: 'What is the default port for PostgreSQL?' },
    chat: { error: 'Ollama is not running. Start it with: ollama serve' }
  });
  assert(e4.isError, 'event 4 must be isError');
  assert(e4.res.content[0].text.includes('Ollama is not running'),
    'event 4 must surface the real Ollama failure');
  assert.strictEqual(e4.chatCalls, 1, 'event 4 reaches the LLM (which then errors)');

  // ── Event 5: ollama empty -> isError, transcription attached, distinct. ──
  const e5 = await run({
    cap: { speech_detected: true, stopped_by: 'silence' },
    transcription: { transcription: 'What is the default port for PostgreSQL?' },
    chat: { response: '', model: 'llama3.2' }
  });
  assert(e5.isError, 'event 5 must be isError');
  assert.strictEqual(e5.data.transcription, 'What is the default port for PostgreSQL?',
    'event 5 must attach the successful transcription');
  assert.strictEqual(e5.data.response, null, 'event 5: response null');
  assert.strictEqual(typeof e5.data.message, 'string', 'event 5: a message exists');
  // Events 3, 4, 5 must be distinct outcomes, not one collapsed message.
  assert.notStrictEqual(e3.res.content[0].text, e4.res.content[0].text, 'events 3 and 4 must differ');
  assert.notStrictEqual(e4.res.content[0].text, e5.res.content[0].text, 'events 4 and 5 must differ');
  console.log('OK events-3-4-5 (each a distinct isError with its real cause)');

  // ── Normal: words + answer -> non-error. ─────────────────────────────────
  const normal = await run({
    cap: { speech_detected: true, stopped_by: 'silence' },
    transcription: { transcription: 'What is the default port for PostgreSQL?' },
    chat: { response: 'PostgreSQL uses port 5432 by default.', model: 'llama3.2' }
  });
  assert(!normal.isError, 'normal must be non-error');
  assert.strictEqual(normal.data.transcription, 'What is the default port for PostgreSQL?');
  assert.strictEqual(normal.data.response, 'PostgreSQL uses port 5432 by default.');
  assert.strictEqual(normal.data.model, 'llama3.2');
  console.log('OK normal (transcription + answer)');

  console.log('OK voicequery-contract');
})().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
