# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-13

### Changed

- **Breaking: device indexes are renumbered.** Device enumeration comes from
  the new capture engine, so the indexes and names reported by
  `list_audio_devices` differ from 0.1.x: indexes are renumbered from a
  different base, Windows loopback endpoints are no longer listed, and
  device names use the shorter WASAPI form. A hardcoded `device` index
  recorded under 0.1.x will silently select a different microphone, or fail
  if it is now out of range. Re-run `list_audio_devices` after upgrading and
  switch to the stable `id`, which does not shift.
- Upgraded decibri from 1.0.0 to 5.0.0. The capture engine is now Rust
  (cpal) rather than C++ (PortAudio), shipped as prebuilt per-platform
  binaries with no install script and no source-build fallback.
- A microphone whose native rate differs from the requested 16 kHz is now
  resampled inside the capture engine, so recordings are delivered at the
  configured rate on every device.
- npm publishing now uses trusted publishing (OIDC) with provenance and a
  manual approval gate. No npm token is involved.

### Added

- Each device returned by `list_audio_devices` now includes a stable `id`
  string alongside `index`, `name`, `maxInputChannels`, `defaultSampleRate`,
  and `isDefault`. The `id` survives reboots and device changes; `index` is
  positional and `name` is not unique. Rarely, a device the host cannot
  identify reports an empty `id` and remains selectable by index.
- The `device` parameter of `capture_audio` and `voice_query` accepts the
  stable device `id` (string) as well as the numeric index. Existing callers
  passing a number are unchanged.
- On platforms decibri publishes no binary for, mcp-listen now fails at
  startup with a message naming the platform and listing the supported set,
  instead of surfacing the module loader's generic error.
- Cross-platform CI: the smoke tests run on Linux, Windows, and macOS across
  Node.js 18, 20, and 22 on every push and pull request.

### Removed

- Intel Mac (darwin-x64) support. Apple has discontinued the platform and no
  decibri 5.x binary is published for it. decibri 1.x could fall back to
  compiling from source at install time; 5.x ships prebuilt binaries only,
  so the fallback that made Intel Mac work is gone.

### Fixed

- `capture_audio` delivers exactly the requested duration of audio. Capture
  now stops once the requested amount of PCM has arrived rather than on a
  wall-clock timer, so stream startup time is no longer silently deducted
  from the recording and the WAV payload is byte-exact.

## [0.1.3] - 2026-04-16

### Changed

- Updated project metadata after the repository transfer to the decibri
  organization: `mcpName` is now `io.github.decibri/mcp-listen`, and the
  author, repository, homepage, and README links point at decibri.

### Fixed

- LICENSE copyright holder corrected to Decibri.

## [0.1.2] - 2026-04-09

### Added

- `server.json` manifest for MCP Registry publication.

### Changed

- README description revised; decibri links updated from decibri.dev to
  decibri.com.

## [0.1.1] - 2026-04-06

### Added

- `mcpName` field in `package.json` for MCP Registry ownership verification.

## [0.1.0] - 2026-04-05

### Added

- Initial release: a stdio MCP server giving MCP-compatible agents access to
  the microphone.
- `list_audio_devices` tool: enumerate available audio input devices.
- `capture_audio` tool: record from the microphone for a requested duration
  (100 to 30000 ms) and save as WAV, with duration validation, concurrent
  capture protection, and safety timeouts.
- `voice_query` tool: capture, transcribe with whisper.cpp, and query a local
  Ollama LLM. Whisper and Ollama are optional dependencies; the capture tools
  work without them.
- Smoke test suite covering server initialization, tool advertising, device
  listing, WAV output validation, and error responses.
- Tag-triggered npm publish workflow.

[Unreleased]: https://github.com/decibri/mcp-listen/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/decibri/mcp-listen/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/decibri/mcp-listen/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/decibri/mcp-listen/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/decibri/mcp-listen/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/decibri/mcp-listen/releases/tag/v0.1.0
