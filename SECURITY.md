# Security

mcp-listen takes security seriously. It is an MCP server that captures audio from the user's microphone, can transcribe it locally, and can pass the transcribed text to a language model, so we are especially attentive to input validation, file handling, and what leaves the machine. If you believe you have found a security vulnerability in this repository, please report it as described below.

## Responsible Disclosure

We are strongly committed to the responsible disclosure of security vulnerabilities. Please follow these guidelines when reporting security issues:

- Email **security@decibri.com** with "SECURITY - mcp-listen" in the subject line.
- Alternatively, use GitHub's [private vulnerability reporting](https://github.com/decibri/mcp-listen/security/advisories/new) to report directly through GitHub.
- Please do not report security vulnerabilities through public GitHub issues.

When reporting, please include the following details where applicable:

- A description of the vulnerability and how it can be exploited
- The affected version of the package
- The platform and architecture (e.g. Windows x64, macOS arm64, Linux x64, Linux arm64)
- The MCP client in use, if relevant
- Steps to reproduce the issue
- Any other relevant information that could help us fix the vulnerability

We review reports as quickly as possible and work with reporters to coordinate remediation and disclosure.

## What mcp-listen Accesses

Understanding what the server touches is useful context when assessing the impact of a report.

mcp-listen:

- Reads from audio input devices when a capture tool is invoked
- Writes WAV files to the system temporary directory. `capture_audio` returns the recording's path to the caller; `voice_query` deletes its recording when the query completes. At startup the server removes its own recordings older than 24 hours from the temporary directory, matching only the file names it generates, so `capture_audio` recordings do not accumulate indefinitely.
- Transcribes captured audio locally, in process, using whisper.cpp. Audio never leaves the machine.
- Sends transcribed text to the local Ollama daemon at `127.0.0.1:11434` when `voice_query` is used. This is the only network call in the codebase. An Ollama daemon configured with cloud models will relay that text off the machine; that relay is a property of the user's Ollama configuration, not of mcp-listen, but it is worth knowing when assessing where text can travel.
- Reads the `WHISPER_MODEL_PATH` environment variable to locate the local Whisper model. It reads no API credentials: none are used. The bundled Ollama client library can read `OLLAMA_API_KEY`, but it attaches that credential only to requests to `ollama.com`, and mcp-listen only ever calls the local daemon, so that code path is unreachable.

It does not collect telemetry or phone home. It runs with the privileges of the user who starts it.

## Why mcp-listen Runs Natively

mcp-listen does not ship a container image. This is a considered position, not an omission.

The server's purpose is to capture audio from the host machine's microphone, and containerisation is not a meaningful boundary for that job:

- On macOS and Windows, a container cannot reach the host microphone in any standard configuration: Linux containers run inside a virtual machine with no route to the host's audio hardware, and Windows-native containers have no audio capture support.
- On Linux, a container can reach the microphone only by passing the audio device or the sound-server socket through the container boundary, which reopens exactly the boundary the container was supposed to provide.
- Containerisation adds no consent layer either. Where the operating system has microphone consent controls (the per-app prompt on macOS, the desktop-app microphone privacy setting on Windows), they govern native processes; a containerised capture path would sit outside those controls, not strengthen them.

The runtime posture is the mitigation instead: the server speaks only stdio to the client that spawned it, opens no listening sockets, makes no network calls other than to the local Ollama daemon, executes no code at install time, and runs as the user who started it.

## Supply Chain and Package Integrity

mcp-listen is published to npm as a single JavaScript package. It ships no binaries of its own; the native audio layer comes from the `decibri` dependency, which has its own security policy.

### Build integrity

- The package is published exclusively from GitHub Actions on GitHub-hosted runners. Nothing is published manually.
- Publishing is triggered only by tagged releases and is gated behind a protected GitHub environment requiring manual approval, restricted to `v*` tags.
- The published package is assembled into a build directory by a generator that copies the runtime files and writes a manifest containing only an explicit allowlist of consumer-facing fields. The development manifest, with its scripts and tooling, is never published.
- A pre-publish verification gate asserts that every file the package ships is present in the tarball, that no credential, publisher binary, or test fixture is present, and that the published manifest carries no scripts and no development dependencies. It fails the release otherwise.
- The full build and release configuration is open source and auditable in `.github/workflows/publish.yml`.

### Publishing and authentication

- npm publishing uses Trusted Publishing via OIDC. No long-lived npm tokens are stored in the repository or CI system. Each publish uses a short-lived, workflow-specific credential issued by npm.
- The MCP registry entry (`io.github.decibri/mcp-listen`) is published by the same release workflow, after the npm publish succeeds and behind the same approval-gated environment. Authentication also uses OIDC: the registry derives the namespace from the repository the workflow runs in, so no registry credential is stored in the repository or CI system either.
- The package declares no install or post-install scripts, and neither does any package in its dependency tree. Installing mcp-listen executes no code on the consumer's machine.

### Provenance and attestation

- Every release publishes with npm provenance attestation, cryptographically linking the published version to the exact source commit and build workflow.
- Provenance attestations are recorded in the public Sigstore transparency log and can be verified with `npm audit signatures`.

### Dependency monitoring

- Dependencies are continuously monitored by Dependabot for security advisories and version updates.
- Every pull request and every push to `main` runs the test suite on Linux, macOS, and Windows across Node.js 18, 20, and 22.

## Supported Versions

This security policy applies to the following versions:

| Version | Supported |
| --- | --- |
| 0.5.x | Yes |
| < 0.5 | No |

Security fixes are applied to the latest release only. mcp-listen is pre-1.0 and older versions are not backported. Upgrade to the latest release.

## Scope

**In scope:**

- The mcp-listen server itself: tool input handling, file handling, and the audio capture path
- The published npm package and its release process
- Anything that allows an untrusted MCP client to cause mcp-listen to act outside its intended behaviour

**Out of scope:**

- Vulnerabilities in dependencies. Report those to the dependency's maintainers. If a dependency vulnerability is exploitable *through* mcp-listen in a way specific to how mcp-listen uses it, that is in scope and we want to hear about it.
- The behaviour of the language model or MCP client that invokes mcp-listen
- Issues requiring an attacker to already have local access to the machine, since mcp-listen runs with the privileges of the user who starts it

## CVE Policy

For confirmed vulnerabilities, we will request a CVE identifier where appropriate and publish a GitHub Security Advisory with details of the issue, affected versions, and remediation steps. Security advisories are visible at the [mcp-listen security advisories page](https://github.com/decibri/mcp-listen/security/advisories).

## Security Best Practices for Users

- Keep your dependencies up to date regularly
- Only install mcp-listen from the official npm registry
- Verify provenance attestations on installed packages with `npm audit signatures`
- Run `npm audit` regularly to check for known vulnerabilities in your dependency tree
- Be aware that `voice_query` sends transcribed text to the local Ollama daemon, and that a daemon configured with cloud models will relay that text off the machine
- Grant microphone access following the principle of least privilege

## Reporting Concerns About This Policy

If you have questions about this security policy itself, or suggestions for improvement, please open a regular issue on the repository. These are not security vulnerability reports and do not require private disclosure.

## Acknowledgments

Thank you to the researchers and community members who help keep mcp-listen users secure. If you report a valid vulnerability and would like public acknowledgment, we will credit you in the security advisory and release notes.

## Contact

For security questions, email **security@decibri.com** with "SECURITY - mcp-listen" in the subject line.
