'use strict';

// Builds the publish package and packs it for real, then verifies the
// published-manifest contract, on any platform. Run by test/smoke.js;
// exits nonzero on any assertion failure.
//
// The source package.json is two documents in one: the development
// manifest and the published one. scripts/build-package.js generates the
// published manifest from an explicit field allowlist into dist/, and
// npm pack / npm publish operate on that directory. This test pins the
// consequences:
//
//   - The source package.json is only ever read: it must be byte-identical
//     after a full build-and-pack cycle.
//   - The packed manifest carries no development fields (scripts,
//     devDependencies, files, publishConfig), so `npm test` in an
//     installed copy gets npm's honest "Missing script" report instead of
//     failing on a test file that is deliberately not shipped.
//   - The load-bearing published fields survive: mcpName (the MCP
//     Registry validates ownership against it) and optionalDependencies
//     (the whisper addon and ollama install through it; without it,
//     voice_query dies for every consumer).
//   - The tarball contains exactly the runtime file set, nothing more.

const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const IS_WINDOWS = process.platform === 'win32';

// npm is npm.cmd on Windows and .cmd files only run through a shell.
// With a shell, spawnSync does not quote arguments, so any argument that
// could contain spaces is quoted by the caller.
function runNpm(args, opts = {}) {
  return spawnSync(IS_WINDOWS ? 'npm.cmd' : 'npm', args, {
    encoding: 'utf8',
    shell: IS_WINDOWS,
    timeout: 180000,
    ...opts
  });
}

function quoteForShell(value) {
  return IS_WINDOWS ? `"${value}"` : value;
}

function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-listen-pack-test-'));
try {
  const sourceManifestBefore = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  const sourcePkg = JSON.parse(sourceManifestBefore);
  assert(sourcePkg.scripts && sourcePkg.scripts.test,
    'precondition: the source manifest must declare a test script');

  // Build the publish package. Twice: the build must be idempotent.
  for (let i = 0; i < 2; i++) {
    const build = spawnSync(process.execPath,
      [path.join(ROOT, 'scripts', 'build-package.js')], { encoding: 'utf8' });
    assert.strictEqual(build.status, 0, `build-package failed:\n${build.stderr}`);
  }

  // Pack the generated directory for real.
  const pack = runNpm(
    ['pack', quoteForShell(DIST), quoteForShell(`--pack-destination=${workDir}`)],
    { cwd: ROOT }
  );
  assert.strictEqual(pack.status, 0,
    `npm pack failed:\n${(pack.stderr || '') + (pack.stdout || '')}`);

  // The single most important assertion: nothing in the build-and-pack
  // cycle may write to the source manifest.
  const sourceManifestAfter = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  assert.strictEqual(sourceManifestAfter, sourceManifestBefore,
    'the source package.json must be byte-identical after build and pack');

  const tarball = fs.readdirSync(workDir).find((f) => f.endsWith('.tgz'));
  assert(tarball, `npm pack produced no tarball in ${workDir}`);

  // tar ships with every platform this package supports (bsdtar on
  // Windows 10+, GNU/BSD tar on Linux and macOS).
  const extract = spawnSync('tar', ['-xzf', path.join(workDir, tarball), '-C', workDir], { encoding: 'utf8' });
  assert.strictEqual(extract.status, 0, `tar extraction failed: ${extract.stderr}`);
  const packedDir = path.join(workDir, 'package');

  // Exactly the runtime file set, nothing else.
  assert.deepStrictEqual(listFiles(packedDir), [
    'ATTRIBUTION.md',
    'LICENSE',
    'README.md',
    'index.js',
    'lib/audio.js',
    'lib/cleanup.js',
    'lib/llm.js',
    'lib/transcribe.js',
    'lib/validate.js',
    'lib/wav.js',
    'package.json'
  ], 'the tarball must contain exactly the runtime file set');

  const packed = JSON.parse(fs.readFileSync(path.join(packedDir, 'package.json'), 'utf8'));

  // Development-only fields must not reach consumers.
  for (const field of ['scripts', 'devDependencies', 'files', 'publishConfig']) {
    assert.strictEqual(packed[field], undefined,
      `the published manifest must not carry "${field}", got: ${JSON.stringify(packed[field])}`);
  }

  // Load-bearing published fields must survive the allowlist.
  assert.strictEqual(packed.name, sourcePkg.name);
  assert.strictEqual(packed.version, sourcePkg.version);
  assert.strictEqual(packed.mcpName, sourcePkg.mcpName,
    'mcpName must be published: the MCP Registry validates ownership against it');
  assert.deepStrictEqual(packed.optionalDependencies, sourcePkg.optionalDependencies,
    'optionalDependencies must be published: whisper and ollama install through it');
  assert.deepStrictEqual(packed.dependencies, sourcePkg.dependencies);
  assert.deepStrictEqual(packed.bin, sourcePkg.bin);
  assert.deepStrictEqual(packed.os, sourcePkg.os);
  assert.deepStrictEqual(packed.cpu, sourcePkg.cpu);

  // The user-facing outcome: npm test in an installed copy reports the
  // script as absent instead of failing on a module that was never
  // shipped.
  const installedTest = runNpm(['test'], { cwd: packedDir });
  const output = (installedTest.stderr || '') + (installedTest.stdout || '');
  assert.notStrictEqual(installedTest.status, 0, 'npm test in the packed copy is expected to fail');
  assert(/missing script/i.test(output),
    `npm test in the packed copy must report a missing script, got:\n${output}`);
  assert(!/cannot find module/i.test(output),
    `npm test in the packed copy must not fail with a missing module, got:\n${output}`);

  console.log('OK packed-manifest');
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}
