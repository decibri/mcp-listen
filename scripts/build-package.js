'use strict';

// Assembles the publishable package into dist/. npm pack and npm publish
// are pointed at that directory; the source package.json is read and
// never written.
//
// The source manifest is two documents in one file: the development
// manifest (test scripts, how the project is built) and the published
// manifest (what a consumer's npm reads). `files` allowlists what ships
// in the tarball, but nothing allowlists what the manifest itself says,
// which is how an unshippable test script reached consumers. The
// generated manifest fixes that by construction: it carries exactly the
// fields below, so a field added to the source manifest never reaches
// the published one without being added here deliberately.
//
// Two fields beyond the obvious consumer set are load-bearing:
//   - mcpName: the MCP Registry validates ownership by reading this from
//     the published npm package. Dropping it breaks registry publishes.
//   - optionalDependencies: the whisper addon and the ollama client
//     install through it. Dropping it silently disables voice_query for
//     every consumer.
// Deliberately absent: scripts (test/ is not shipped, and an installed
// copy must get npm's "Missing script" report, not a missing-module
// error), devDependencies, files (the built directory is the file list),
// and publishConfig.
const MANIFEST_FIELDS = [
  'name',
  'version',
  'description',
  'mcpName',
  'keywords',
  'homepage',
  'bugs',
  'repository',
  'license',
  'author',
  'type',
  'main',
  'bin',
  'engines',
  'os',
  'cpu',
  'dependencies',
  'optionalDependencies'
];

// The runtime files, mirroring the tarball the `files` allowlist used to
// produce: the server entry, the lib modules, and the documents npm and
// consumers expect alongside them.
const PACKAGE_FILES = ['index.js', 'lib', 'README.md', 'LICENSE', 'ATTRIBUTION.md'];

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const manifest = {};
for (const field of MANIFEST_FIELDS) {
  if (source[field] !== undefined) manifest[field] = source[field];
}

// Rebuild from scratch every run: stale files from a previous build must
// not survive into the next tarball.
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST);
fs.writeFileSync(path.join(DIST, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
for (const name of PACKAGE_FILES) {
  fs.cpSync(path.join(ROOT, name), path.join(DIST, name), { recursive: true });
}

console.error(`[build-package] built dist/ for ${manifest.name}@${manifest.version}`);
