'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// capture_audio's contract is to return the recording's path, so its WAV
// cannot be deleted when the call completes; before this sweep existed,
// those files simply accumulated in the temp directory forever, which is
// a privacy problem as much as a disk one (they are microphone
// recordings). The sweep runs once at server start and removes only
// recordings old enough that no caller can still be using them.
//
// The retention window is deliberately generous: a caller is expected to
// consume the file within its session, and 24 hours outlives any
// plausible session while still bounding accumulation to one day of
// recordings between restarts.
const RETENTION_MS = 24 * 60 * 60 * 1000;

// Exactly the names capture_audio generates: the prefix, a millisecond
// timestamp, the extension. Anything else in the temp directory, however
// similar, was not created by this tool and is never touched.
const RECORDING_NAME = /^mcp-listen-\d+\.wav$/;

// Best-effort by design: an unreadable directory, a locked file, or a
// file deleted underneath us must neither throw nor stop the sweep. The
// caller fires this without awaiting it, so server startup never blocks
// on it. Returns the number of files removed.
async function sweepStaleRecordings({ dir = os.tmpdir(), maxAgeMs = RETENTION_MS } = {}) {
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }

  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of names) {
    if (!RECORDING_NAME.test(name)) continue;
    const filePath = path.join(dir, name);
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
      await fs.promises.unlink(filePath);
      removed++;
    } catch {
      // Locked, already gone, or unreadable: leave it and keep going.
    }
  }
  return removed;
}

module.exports = { sweepStaleRecordings, RETENTION_MS };
