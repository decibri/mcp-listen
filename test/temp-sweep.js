'use strict';

// Deterministic coverage of the startup temp-file sweep in lib/cleanup.js,
// runnable on any platform. The sweep runs against a private directory
// seeded with known files and mtimes, so the assertions are exact: it
// must remove precisely the stale recordings it created the names for,
// and nothing else. Run by test/smoke.js; exits nonzero on any failure.

const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const { sweepStaleRecordings, RETENTION_MS } = require('../lib/cleanup');

const HOUR_MS = 60 * 60 * 1000;

function touch(dir, name, ageMs) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, 'x');
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, when, when);
  return filePath;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-listen-sweep-test-'));
  try {
    // Stale recordings: must be removed.
    touch(dir, 'mcp-listen-1712345678901.wav', RETENTION_MS + HOUR_MS);
    touch(dir, 'mcp-listen-1.wav', RETENTION_MS + 48 * HOUR_MS);

    // Fresh recording: inside the retention window, must survive.
    touch(dir, 'mcp-listen-1712345678999.wav', HOUR_MS);

    // Old files the tool did NOT create: similar names, wrong shape.
    // Every one must survive regardless of age.
    const strangers = [
      touch(dir, 'someone-elses-1712345678901.wav', RETENTION_MS + HOUR_MS),
      touch(dir, 'mcp-listen-notes.wav', RETENTION_MS + HOUR_MS),
      touch(dir, 'mcp-listen-.wav', RETENTION_MS + HOUR_MS),
      touch(dir, 'mcp-listen-123.wav.bak', RETENTION_MS + HOUR_MS),
      touch(dir, 'mcp-listen-123.txt', RETENTION_MS + HOUR_MS)
    ];

    // A directory whose NAME matches the pattern: must survive (isFile).
    const decoyDir = path.join(dir, 'mcp-listen-99.wav');
    fs.mkdirSync(decoyDir);
    const past = new Date(Date.now() - RETENTION_MS - HOUR_MS);
    fs.utimesSync(decoyDir, past, past);

    const removed = await sweepStaleRecordings({ dir });
    assert.strictEqual(removed, 2, `expected exactly the 2 stale recordings removed, got ${removed}`);

    assert(!fs.existsSync(path.join(dir, 'mcp-listen-1712345678901.wav')), 'stale recording must be removed');
    assert(!fs.existsSync(path.join(dir, 'mcp-listen-1.wav')), 'stale recording must be removed');
    assert(fs.existsSync(path.join(dir, 'mcp-listen-1712345678999.wav')), 'fresh recording must survive');
    for (const stranger of strangers) {
      assert(fs.existsSync(stranger), `file the tool did not create must survive: ${stranger}`);
    }
    assert(fs.existsSync(decoyDir), 'a directory matching the name pattern must survive');

    // A shorter window via the option: the fresh file becomes stale.
    const removedShort = await sweepStaleRecordings({ dir, maxAgeMs: 0 });
    assert.strictEqual(removedShort, 1, `expected the remaining recording removed, got ${removedShort}`);
    assert(!fs.existsSync(path.join(dir, 'mcp-listen-1712345678999.wav')));

    // A missing directory returns 0 rather than throwing.
    const gone = await sweepStaleRecordings({ dir: path.join(dir, 'does-not-exist') });
    assert.strictEqual(gone, 0, 'missing directory must be a no-op');

    console.log('OK temp-sweep');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
