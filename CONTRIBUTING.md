# Welcome to the mcp-listen Contribution Guide

Thank you for investing your time in contributing to mcp-listen. We welcome all sorts of different contributions.

Before making any type of contribution, please read our [Code of Conduct](https://github.com/decibri/mcp-listen/blob/main/CODE_OF_CONDUCT.md) to keep our community approachable and respectable.

This guide walks through the contribution workflow, from opening an issue to submitting a pull request.

## New contributor resources

For a good overview of the project, please first read the [README](https://github.com/decibri/mcp-listen/blob/main/README.md). General resources for getting started with open-source contributions:

- [Finding ways to contribute to open source on GitHub](https://docs.github.com/en/get-started/exploring-projects-on-github/finding-ways-to-contribute-to-open-source-on-github)
- [Collaborating with pull requests](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests)

## Ways to contribute

There are multiple ways you can contribute to this project:

- Reporting a bug
- Submitting a fix
- Suggesting new features or improvements
- Adding or updating documentation
- Improving test coverage
- Anything else we may have forgotten

## Getting started

### Prerequisites

To develop mcp-listen you will need:

- **Node.js 18 or later** (`package.json` declares `engines: node >=18`, and CI tests on Node 18, 20, and 22)
- Platform-specific dependencies:
  - **Windows**: none
  - **macOS**: none
  - **Linux**: `sudo apt-get install libasound2-dev` (the native audio layer links ALSA)

Supported platforms are Windows x64, macOS Apple silicon (arm64), and Linux x64 and arm64 (glibc). Intel Mac (darwin-x64) is not supported: Apple has discontinued the platform and no decibri binary is published for it.

A microphone is needed for the full test suite. Without one the hardware-dependent tests skip rather than fail, so you can still develop on a machine with no audio input; see [Running the tests](#running-the-tests).

### Setting up the development environment

1. Fork this repository to your own account and clone it to your local machine:

   ```bash
   git clone https://github.com/YOUR_USERNAME/mcp-listen.git
   cd mcp-listen
   ```

2. Install dependencies from the committed lock file:

   ```bash
   npm ci
   ```

   Use `npm ci`, not `npm install`: `package-lock.json` is committed and CI installs from it, so `npm ci` gives you exactly the dependency tree a green CI run proves.

3. Run the test suite:

   ```bash
   npm test
   ```

### Running the tests

`npm test` runs `test/smoke.js`: a single self-contained runner with no test framework. It spawns the real server (`index.js`) as a child process and drives it over stdio with JSON-RPC, the same way an MCP client does, and runs its deterministic companion suites as child processes.

Most of the suite needs no hardware at all. The protocol and schema checks, the argument-validation batches, the simulated device states (`test/stub-device-states.js`), the optional-dependency load failures (`test/stub-loader-errors.js`), the startup temp-file sweep (`test/temp-sweep.js`), and the build-and-pack verification (`test/packed-manifest.js`) are deterministic and run identically on any machine, with no microphone, no Whisper model, and no Ollama daemon.

The capture tests are the exception: they record short bursts (500ms) from your actual audio devices and delete the recordings afterwards. On a machine with no audio input devices they skip rather than fail; the runner prints `SKIP` lines and still exits green. A smaller pass count with a few skips on a headless machine is expected, not a problem.

One Windows-specific note: run `npm test` from PowerShell or Command Prompt rather than from a Git Bash terminal. The packed-manifest suite extracts a tarball with `tar`, and the GNU tar that Git Bash puts on `PATH` misreads Windows drive paths like `C:\...` as remote host addresses and fails; the bsdtar that ships with Windows handles them correctly.

### Repository layout

- `index.js`: the MCP server entry point, and the package's `bin`
- `lib/`: the implementation: audio capture (`audio.js`), argument validation (`validate.js`), transcription (`transcribe.js`), the Ollama call (`llm.js`), WAV writing (`wav.js`), and the startup temp-file sweep (`cleanup.js`)
- `test/`: the smoke-test runner and its deterministic companion suites
- `scripts/`: `build-package.js`, which assembles the publishable package into `dist/`
- `.github/workflows/`: CI (`ci.yml`), the release pipeline (`publish.yml`), and the CLA check (`cla.yml`)

### Dependencies

`package-lock.json` is committed so CI installs a fixed dependency resolution. Please do not update it as a side effect of an unrelated change.

The Whisper addon (`@kutalia/whisper-node-addon`) and the Ollama client (`ollama`) are optional dependencies: they back the `voice_query` tool and nothing else requires them. The test suite covers their load-failure paths deterministically, so you do not need a Whisper model or an Ollama daemon to develop here.

### Reporting a bug

We use GitHub Issues to track bugs. All open, pending, and closed cases are at [mcp-listen Issue Tracking](https://github.com/decibri/mcp-listen/issues).

Before opening a new issue, please search [existing issues](https://github.com/decibri/mcp-listen/issues) to see if the bug has already been reported. You may be able to add more information or your own experience to an existing issue.

If no related issue exists, you can open a new one using the [issues form](https://github.com/decibri/mcp-listen/issues/new).

To help us reproduce and fix bugs quickly, please include the following where applicable:

- A quick summary and background
- Your operating system and architecture (e.g. Windows 11 x64, macOS arm64, Ubuntu 22.04 x64)
- Node.js version (`node --version`)
- The output of the `list_audio_devices` tool if the issue is audio-related. It is the single most useful thing you can include, and it costs one tool call.
- The MCP client in use (e.g. Claude Desktop, Claude Code, Cursor)
- Steps to reproduce the bug
- What you expected to happen vs what actually happened
- Exact error messages (screenshots are fine, de-identified if needed)

### Reporting a security vulnerability

Security vulnerabilities must not be reported in public GitHub issues. Please follow [SECURITY.md](https://github.com/decibri/mcp-listen/blob/main/SECURITY.md) instead: email **security@decibri.com** or use GitHub's private vulnerability reporting.

### Proposing codebase changes

We welcome contributions from everyone interested in making mcp-listen better. To propose a change:

1. Fork this repository and clone it to your local machine.
2. Create a new branch from `main` with a descriptive name that reflects your changes.
3. Make your changes.
4. Run `npm test` and make sure it passes. If your change affects the capture path, test it on a machine with a real microphone; CI cannot fully cover capture (see [CI pipeline](#ci-pipeline)).
5. Commit your changes with a clear and descriptive commit message.
6. Push your branch to your fork.
7. Open a pull request against the `main` branch of this repository. Include a description of your changes, the reasons for them, and the benefits they provide.

Our team will review your PR and provide feedback. We may ask for additional changes, so please be prepared to iterate before merging.

### CI pipeline

Every pull request runs the test suite on nine legs: Linux, macOS, and Windows, each on Node.js 18, 20, and 22. Your PR must pass CI before it can be merged. Details of the pipeline live in `.github/workflows/ci.yml`.

One honest caveat about coverage: none of the CI runners has a physical microphone. The macOS runners expose a virtual default sound device and run the full default-path capture through it; the Linux runners enumerate only the ALSA null device, which exercises the no-default refusal and explicit-selection paths; the Windows runners enumerate no audio devices at all, so the capture tests skip there. If your change touches the capture path, test it locally on real hardware, because CI cannot.

We appreciate your contributions and thank you for your time in submitting a pull request.

## Contributor License Agreement

Before your first contribution can be merged, we ask you to agree to the decibri Contributor License Agreement. It is a one-time step that lets the project include your work under its current and future licenses, with clear provenance, and it does not take away your copyright in what you contribute. You are welcome to read the full agreements first: the [Individual CLA](https://github.com/decibri/decibri-cla-action/blob/main/agreements/Individual-CLA-v1.md) and, for contributions made on behalf of a company, the [Corporate CLA](https://github.com/decibri/decibri-cla-action/blob/main/agreements/Corporate-CLA-v1.md).

When you open a pull request, an automated check looks at whether you are already covered. If you are not, it leaves a comment with a short sentence to agree to. Reply with that exact sentence as a comment on your own pull request, and the check turns green. That is the whole process, and once you have done it you are covered for your future contributions too. Until the check passes, the pull request cannot be merged.

If you are contributing as part of your work, your employer may need a Corporate CLA on file instead of an individual one. If that applies to you, or the check asks about it, contact the maintainers and we will sort it out.

The record we keep is deliberately minimal: your GitHub username and account ID, the version of the agreement you agreed to, the date, and a link to the pull request comment where you agreed. How we handle that information, and how to request its removal, is set out in our [Privacy Policy](https://decibri.com/privacy).

The CLA covers your contributions across the decibri organisation's repositories, so you only need to agree once.

## License

The mcp-listen source is released under the [Apache License 2.0](https://github.com/decibri/mcp-listen/blob/main/LICENSE).

Contributions are governed by the Contributor License Agreement described above. Under the CLA you keep your copyright in what you contribute and grant the project the rights it needs to include and license your work, including under future licenses. Contributed code or content must be your own work, and you confirm that you have the right to grant those rights.
