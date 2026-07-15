# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-07-15

### Added

- Silence-stopped capture. `capture_audio` gains `stop_on_silence`
  (default `false`): when set, the recording ends when the speaker stops
  talking, detected with the Silero voice-activity model that ships
  inside decibri and runs on-device through its bundled ONNX Runtime, so
  nothing extra is downloaded and no audio leaves the machine. In that
  mode `duration_ms` becomes a maximum rather than an exact length, and
  the new `silence_ms` argument (default 1000, range 100-10000) sets how
  much continuous silence ends the recording. Recording ends at the
  first of: `silence_ms` of continuous post-speech silence, the
  `duration_ms` ceiling, or 10 seconds with no speech at all. The result
  reports the actual captured `duration_ms`, which condition ended it
  (`stopped_by`), and whether speech was heard (`speech_detected`).
  Every stop condition is measured in delivered audio, never wall-clock
  timers, so the stop point is an exact function of the audio; the
  detector only decides when to stop and never alters the recorded
  samples, and a fixed-duration capture is unchanged byte for byte.
- `voice_query` stops on silence by default, with a 15 second ceiling.
  Its only consumer is speech transcription and a spoken query has no
  known length, so the previous fixed window truncated long questions
  and recorded silence after short ones. `stop_on_silence: false`
  restores the previous fixed 5 second window exactly.
- Deterministic test suites, runnable on every platform with no
  microphone, whisper, or Ollama: the silence-stop state machine
  (scripted per-chunk scores pinning the exact stop chunk and byte count
  for each stop condition) and the `voice_query` no-answer contract
  (including that a filler-only transcription never reaches the model).

### Changed

- `voice_query`'s no-answer results are restructured, and a caller that
  branched on the previous shapes will observe the change. No speech at
  all, and speech that produced no usable words, are now non-error
  results whose machine-readable contract is `speech_detected` (`false`
  vs `true`) with `transcription: null`, so a caller distinguishes "the
  user was silent" from "the user spoke but produced no words" without
  parsing prose. Empty transcription previously returned `isError: true`
  and no longer does. A transcription failure, an unreachable or erroring
  Ollama, and an empty model response remain `isError: true`, each
  surfacing its real cause. The rule is that a pipeline that ran and
  found no words is a success, while a broken dependency is an error.
  The structured fields are the contract; any human-readable message is
  not, so callers branch on the fields rather than the prose.

### Fixed

- Whisper's non-speech markers no longer reach the language model. When
  a recording contained silence or noise, whisper returns markers such
  as `[BLANK_AUDIO]`, `[MUSIC]`, or `(silence)` as ordinary text, and
  these were forwarded to Ollama as the user's query, so the model
  answered a question the user never asked. A transcription is now
  treated as having usable words only if, after removing every bracketed
  and parenthesised marker, at least one letter or digit remains, so a
  marker-only or whitespace-only transcription is reported as no words
  and never reaches the model. The check is conservative: a real
  transcription that merely contains a bracketed word keeps its words
  and is unaffected.

## [0.4.0] - 2026-07-14

### Fixed

- A whisper addon that is installed but fails to load (for example, a
  missing native library) was reported as "not installed", telling the
  user to run an install command that was already satisfied and could
  not help. The two failure modes are now distinguished: a genuinely
  missing package keeps the install guidance, and a load failure
  reports itself as one and surfaces the underlying loader error, which
  names the thing the user can actually act on. The optional `ollama`
  client had the same defect and is fixed the same way.
- `capture_audio` never removed the WAV files it wrote to the system
  temporary directory. An agent calling it repeatedly accumulated
  recordings of the user's microphone there indefinitely.

### Changed

- WAV files written by `capture_audio` to the temporary directory are
  now removed at server start once they are older than 24 hours. The
  path returned by a call remains valid for the session and well
  beyond it. The sweep matches only the exact file names the tool
  generates, never touches anything else, and cannot fail or delay
  startup. `voice_query` continues to delete its recording as soon as
  the query completes.
- The published package no longer carries a `scripts` block. The
  package is built from a generated manifest holding an explicit
  allowlist of consumer-facing fields, so development-only fields
  cannot reach consumers. `npm test` in an installed copy now reports
  a missing script instead of failing on a test file that is
  deliberately not shipped. The pre-publish gate fails the release if
  the published manifest carries `scripts` or `devDependencies`. The
  tarball's runtime contents are unchanged.
- Documentation brought current: the argument validation introduced in
  0.3.0 is documented, the whisper model section no longer implies the
  model downloads itself, Known Limitations describes the temp-file
  retention, a troubleshooting entry covers the addon load-failure
  message, and the security policy's supported-versions table reflects
  the 0.3+ line.

### Added

- Deterministic test coverage, on every platform, for paths the smoke
  suite could not previously reach: the optional-dependency load
  failures in the transcription and LLM layers (stubbed at the module
  loader, so no whisper model or Ollama daemon is needed), the
  temp-directory sweep, and the packed manifest (builds and packs the
  real tarball, asserts the source manifest is never modified, and
  asserts an installed copy's `npm test` cannot fail on a module that
  was never shipped).

## [0.3.0] - 2026-07-14

### Changed

- **Breaking: arguments not declared in a tool's input schema are now
  rejected rather than silently ignored.** Every tool schema has declared
  `additionalProperties: false` since 0.2.1; it is now enforced. A caller
  sending an undeclared argument, including `output_path` to
  `capture_audio`, receives an error naming the argument and listing the
  accepted ones. Previously such arguments were dropped without notice,
  leaving the caller believing they took effect.
- **Breaking: arguments are now validated against their declared types
  before anything is opened, allocated, or written.** `duration_ms` must
  be a finite integer between 100 and 30000: a string, a fraction, `NaN`,
  or `Infinity` is rejected rather than coerced, where a numeric string
  previously recorded by coercion. `device` must be a non-negative integer
  index or a non-empty string id from `list_audio_devices`; any other type
  is rejected instead of being passed to the capture engine.
  `whisper_model`, `language`, `model`, and `prompt` must be strings.
  Every rejection names the parameter, shows what was received, and states
  what is accepted, and a rejected call writes nothing to disk. `null`
  selects the documented default for every optional parameter, consistent
  with the existing handling of `device: null`. Calls that were valid per
  the declared schemas behave exactly as before; no parameter is added,
  removed, or renamed.
- The WAV file write and the `voice_query` temp file cleanup now use
  asynchronous file I/O, so a capture no longer blocks the event loop
  while its WAV is written or removed. The capture stall guard is cleared
  once the requested audio has arrived, before the write begins, so it
  cannot race the write's result.

### Fixed

- A non-numeric `duration_ms` corrupted the capture stall guard: the value
  was concatenated into the timeout rather than added, so a string such as
  `"500"` produced a stall-guard timeout of roughly 83 minutes, during
  which a stalled stream would have held the microphone open. Type
  validation now rejects the call before the microphone is touched.
- A non-numeric `duration_ms` also passed the range check outright, since
  every comparison with `NaN` is false: the microphone opened with a byte
  target of `NaN` that could never be met, and the capture always ran to
  the stall guard.
- A non-string `whisper_model` failed the request only after recording had
  already happened, surfacing as a protocol-level internal error rather
  than a tool error. It is now rejected before capture.
- `null` for `language`, `model`, or `prompt` was passed raw into the
  transcription and LLM layers; it now selects the documented default.

### Security

- Raised the declared floor for `@modelcontextprotocol/sdk` from `^1.25.2`
  to `^1.26.0`, past the fix for GHSA-345p-7cg4-v4c7 (cross-client data
  leak via shared server or transport instances, patched in 1.26.0). The
  advisory is not reachable in this server, which serves a single client
  over stdio and connects one `Server` to one transport exactly once, but
  the declared range is the only version constraint consumers get and must
  not admit a version inside a published advisory. Nothing this server
  uses requires an SDK newer than 1.25.2; the raise is the advisory, not
  compatibility. This project's own resolution (1.29.0) is unchanged.

## [0.2.1] - 2026-07-14

### Changed

- Every tool input schema now declares `additionalProperties: false` and an
  explicit `required` array. The MCP SDK does not enforce the input schema
  at the transport layer, so this does not change what the handlers accept;
  it tells validating clients and schema-aware layers to reject arguments
  the tool does not declare. No parameter is added, removed, or renamed,
  and every existing valid call is unaffected.
- Raised the declared floor for `@modelcontextprotocol/sdk` from `^1.0.0`
  to `^1.25.2`, past the fixes for GHSA-w48q-cv73-mx4w (patched in 1.24.0)
  and GHSA-8r9q-7v3j-jr4g (patched in 1.25.2). Neither advisory is
  reachable in this server, which speaks stdio only and registers no
  resource templates, but the declared range is the only version
  constraint consumers get: npm does not ship a lockfile inside the
  package, so the floor must not admit a vulnerable version. This
  project's own resolution (1.29.0) is unchanged.

### Added

- `SECURITY.md`: a security policy covering responsible disclosure, what
  the server accesses on the machine it runs on, why it runs natively
  rather than in a container, and the supply chain posture of the
  published package.
- Dependabot configuration covering npm dependencies and GitHub Actions
  workflow versions, on a weekly schedule.

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
- A capture on the default-device path now fails with an actionable error
  when the system has no usable default input device: if no enumerated
  device is flagged default and the capture fails, the error reports the
  device count and points at `list_audio_devices`, with the original error
  included; if the only input device is the ALSA null device (the state of
  headless Linux hosts), the default path refuses rather than recording
  silence. Selecting a device explicitly, including the null device, is
  unaffected.
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

[Unreleased]: https://github.com/decibri/mcp-listen/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/decibri/mcp-listen/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/decibri/mcp-listen/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/decibri/mcp-listen/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/decibri/mcp-listen/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/decibri/mcp-listen/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/decibri/mcp-listen/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/decibri/mcp-listen/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/decibri/mcp-listen/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/decibri/mcp-listen/releases/tag/v0.1.0
