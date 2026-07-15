<!-- markdownlint-disable MD033 MD041 -->

<p align="center">
  <a href="https://decibri.com">
    <img
      src="https://github.com/user-attachments/assets/62a4c561-da48-401d-9142-220854566330"
      alt="Decibri mcp-listen"
      width="100%">
  </a>
</p>

# mcp-listen

**Give your AI agents the ability to listen**

Microphone capture and speech-to-text tools for MCP-compatible agents.
        
<div>
  <!-- badges: start -->
  <table>
    <tr>
      <td><strong>Meta</strong></td>
      <td>
        <a href="https://github.com/decibri/mcp-listen"><img src="https://badge.mcpx.dev?type=server" title="MCP Server" alt="MCP Server" /></a>&nbsp;
        <a href="https://www.npmjs.com/package/mcp-listen"><img src="https://img.shields.io/npm/v/mcp-listen" alt="npm version"></a>&nbsp;
        <a href="https://github.com/decibri/mcp-listen/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="Apache 2.0 License"></a>&nbsp;
        <a href="https://github.com/decibri/mcp-listen/actions/workflows/ci.yml"><img src="https://github.com/decibri/mcp-listen/actions/workflows/ci.yml/badge.svg" alt="CI"></a>&nbsp;
        <a href="https://glama.ai/mcp/servers/decibri/mcp-listen"><img src="https://glama.ai/mcp/servers/decibri/mcp-listen/badges/score.svg" alt="mcp-listen MCP server" /></a>&nbsp;
      </td>
    </tr>
  </table>
  <!-- badges: end -->
</div>

## Tools

| Tool | Description |
| ------ | ------------- |
| `list_audio_devices` | List available microphone input devices |
| `capture_audio` | Record audio from the microphone and save as WAV |
| `voice_query` | Capture, transcribe (whisper.cpp), and query a local LLM (Ollama) |

## Quick Start

### Claude Code

```bash
claude mcp add mcp-listen npx mcp-listen
```

### Claude Desktop / ChatGPT Desktop / Cursor / Windsurf / VS Code

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "mcp-listen": {
      "command": "npx",
      "args": ["-y", "mcp-listen"]
    }
  }
}
```

Compatible with Claude Desktop, ChatGPT Desktop, Cursor, GitHub Copilot, Windsurf, VS Code, Gemini, Zed, and any MCP-compatible client.

### Global Install

```bash
npm install -g mcp-listen
```

## Requirements

**Supported platforms:**

- Windows x64
- macOS Apple silicon (arm64)
- Linux x64 and arm64 (glibc)

Intel Mac (darwin-x64) is not supported: Apple has discontinued the platform and no decibri binary is published for it.

**For `list_audio_devices` and `capture_audio`:**

- Node.js 18+
- A microphone

**For `voice_query` (optional):**

- [Ollama](https://ollama.com) running locally
- Whisper GGML model (see [Whisper Model Setup](#whisper-model-setup))

## Tool Reference

Arguments are validated before anything is recorded or written. An argument a tool does not declare is rejected with an error naming it, rather than silently ignored. `duration_ms` must be an integer between 100 and 30000; `silence_ms` an integer between 100 and 10000; `stop_on_silence` a boolean; `device` a non-negative integer index or a non-empty string id from `list_audio_devices`. A `silence_ms` that cannot take effect (passed without silence-stopping active) is rejected for the same reason unknown arguments are. A rejected call writes nothing to disk.

### list_audio_devices

Returns a JSON array of available audio input devices.

**Parameters:** None

**Example response:**

```json
[
  { "index": 0, "name": "Microphone", "id": "wasapi:{0.0.1.00000000}.{6b187949-26ea-470b-907d-66bf87261530}", "maxInputChannels": 2, "defaultSampleRate": 48000, "isDefault": true },
  { "index": 1, "name": "Microphone Array", "id": "wasapi:{0.0.1.00000000}.{b7a6e3e2-a62b-4e92-9320-947c4be98552}", "maxInputChannels": 2, "defaultSampleRate": 48000, "isDefault": false }
]
```

The `id` is stable across reboots and device changes. The `index` is positional and can shift when devices are added or removed, and names are not unique. Prefer `id` when selecting a device. In the rare case the host cannot produce a stable id for a device, its `id` is an empty string and it can only be selected by `index`.

### capture_audio

Records audio from the microphone and saves as a WAV file. Records for exactly `duration_ms` by default, or until the speaker stops talking with `stop_on_silence: true`.

**Parameters:**

| Parameter | Type | Default | Description |
| ---------- | ------ | --------- | ------------- |
| `duration_ms` | number | 5000 | Recording duration in milliseconds (100-30000). A maximum, not an exact length, when `stop_on_silence` is true |
| `device` | number or string | system default | Device index or stable device `id` from `list_audio_devices` |
| `stop_on_silence` | boolean | false | Stop when the speaker stops talking, detected with on-device voice activity detection (Silero VAD, bundled, no download) |
| `silence_ms` | number | 1000 | Continuous silence in milliseconds that ends a `stop_on_silence` recording (100-10000). Requires `stop_on_silence: true` |

**Example response (fixed duration):**

```json
{
  "path": "/tmp/mcp-listen-1712345678901.wav",
  "duration_ms": 5000,
  "sample_rate": 16000,
  "channels": 1,
  "size_bytes": 160044
}
```

**Example response (`stop_on_silence: true`):**

```json
{
  "path": "/tmp/mcp-listen-1712345678901.wav",
  "duration_ms": 2600,
  "sample_rate": 16000,
  "channels": 1,
  "size_bytes": 83244,
  "stopped_by": "silence",
  "speech_detected": true
}
```

With `stop_on_silence`, `duration_ms` in the response is the actual captured length, and `stopped_by` says how the recording ended: `"silence"` (the speaker finished), `"ceiling"` (the `duration_ms` maximum was reached), or `"no_speech_timeout"` (nobody spoke for 10 seconds; the WAV is still returned, with `speech_detected: false`, so silence is a reported outcome rather than an error). Detection runs per ~100ms audio buffer, so the effective hangover rounds up to the next buffer, and the recording keeps everything from the start of the call through the stop decision: nothing is gated or clipped at speech boundaries, and the audio itself is byte-identical to a fixed-duration capture of the same sounds.

### voice_query

Full voice pipeline: capture audio, transcribe with whisper.cpp, send to Ollama, return the response. Entirely offline. Recording stops automatically when the speaker stops talking; pass `stop_on_silence: false` for a fixed-length recording.

**Parameters:**

| Parameter | Type | Default | Description |
| ----------- | ------ | --------- | ------------- |
| `duration_ms` | number | 15000 / 5000 | Maximum recording duration in milliseconds (100-30000). Default 15000 while silence-stopping is active, 5000 with `stop_on_silence: false` |
| `device` | number or string | system default | Device index or stable device `id` from `list_audio_devices` |
| `stop_on_silence` | boolean | true | Stop recording when the speaker stops talking. Pass false to record for exactly `duration_ms` |
| `silence_ms` | number | 1000 | Continuous silence in milliseconds that ends the recording (100-10000) |
| `whisper_model` | string | ggml-base.en.bin | Path or filename of Whisper GGML model |
| `language` | string | en | Language code for transcription |
| `model` | string | llama3.2 | Ollama model name |
| `prompt` | string | You are a helpful assistant. | System prompt for the LLM |

**Example response:**

```json
{
  "transcription": "What is the default port for PostgreSQL?",
  "response": "PostgreSQL runs on port 5432 by default.",
  "model": "llama3.2"
}
```

**Result outcomes.** `voice_query` reports five distinct outcomes. The **structured fields are the contract** (`isError`, `speech_detected`, `transcription`); any `message` is a human-readable hint whose wording is not part of the contract, so a caller branches on the fields, never on the prose. The rule is simple: **if the pipeline ran, the result is a success (even when it found no words); if a dependency broke, the result is an error.**

| Outcome | `isError` | `speech_detected` | `transcription` | `response` |
| --- | --- | --- | --- | --- |
| Normal | absent | (`true`/omitted) | the text | the answer |
| No speech at all | absent | `false` | `null` | `null` |
| Speech, but no transcribable words | absent | `true` | `null` | `null` |
| Transcription step failed | `true` | — | — | — |
| Ollama unavailable, errored, or empty | `true` | — | — | — |

A caller distinguishes "the user was silent" from "the user spoke but produced no words" by `speech_detected` (`false` vs `true`), both carrying `transcription: null`. Non-speech audio never reaches the language model: whisper's non-speech markers (`[BLANK_AUDIO]`, `[MUSIC]`, `(silence)`, and similar) are treated as no usable words rather than sent on as a query.

**No speech** (`speech_detected: false`):

```json
{
  "speech_detected": false,
  "stopped_by": "no_speech_timeout",
  "transcription": null,
  "response": null,
  "message": "No speech was detected. Ask the user to repeat, or check that the correct microphone is selected."
}
```

**Speech, but no transcribable words** (`speech_detected: true`, `transcription: null`):

```json
{
  "speech_detected": true,
  "stopped_by": "silence",
  "transcription": null,
  "response": null,
  "message": "Speech was detected but could not be transcribed. It may have been too quiet, too brief, or unclear. Ask the user to repeat, a little louder and closer to the microphone."
}
```

Transcription and dependency failures return `isError: true` with the real cause (a missing model, a whisper load failure, Ollama not running, a timeout, or an empty model response), so a caller debugging can tell whether the failure was in capture, transcription, or the language model.

## How It Works

mcp-listen uses [decibri](https://decibri.com) for cross-platform microphone capture. No ffmpeg, no SoX, no system audio tools required. Pre-built native binaries with zero setup.

Audio is captured as 16-bit PCM at 16kHz mono, the standard format for speech-to-text engines.

Silence-stopping uses the Silero voice activity detection model that ships inside decibri, running on-device through the bundled ONNX Runtime. Nothing extra is downloaded and no audio leaves the machine. The stop decision is measured in captured audio, not wall-clock time, and the VAD only decides when to stop: it never gates or alters the recorded samples.

The `voice_query` tool runs the full pipeline locally: capture audio, transcribe with whisper.cpp, and send to a local Ollama LLM. Fully offline, nothing leaves your machine.

## Whisper Model Setup

The `voice_query` tool requires a Whisper GGML model file. Download one:

**Linux / macOS:**

```bash
mkdir -p ~/.mcp-listen/models
curl -L -o ~/.mcp-listen/models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

**Windows (PowerShell):**

```powershell
mkdir "$env:USERPROFILE\.mcp-listen\models" -Force
Invoke-WebRequest -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" -OutFile "$env:USERPROFILE\.mcp-listen\models\ggml-base.en.bin"
```

The model is ~150MB and downloads once. You can also set the `WHISPER_MODEL_PATH` environment variable to a custom directory.

## Ollama Setup

1. Install Ollama from <https://ollama.com>
2. Pull a model: `ollama pull llama3.2`
3. Ensure Ollama is running: `ollama serve`

## Known Limitations

1. **A loud transient can register as speech.** Silence-stopping decides "speech has started" from the VAD score, so a door slam or a cough can start the countdown and end the recording after `silence_ms` of quiet, yielding a short capture of mostly silence. The outcome is visible, not silent: the result reports the actual duration, and `voice_query` reports an empty transcription rather than inventing one. A minimum-speech-duration guard is a candidate refinement.
2. **`voice_query` requires Ollama running.** If Ollama isn't running, the tool returns a clear error message.
3. **Whisper model must be downloaded before first use.** `voice_query` does not download the model itself; the first call requires a pre-downloaded model (~150MB). See [Whisper Model Setup](#whisper-model-setup).
4. **No streaming.** MCP's request/response pattern means the entire recording is captured, then transcribed, then sent to the LLM. No real-time partial results.
5. **Temp files.** `capture_audio` writes WAV files to the system temp directory and returns the path, so the file has to outlive the call for the caller to read it. Recordings older than 24 hours are removed the next time the server starts; recordings made since the last restart persist until then. `voice_query` deletes its recording as soon as the query completes.

## Troubleshooting

**Windows: "Error opening microphone"**
Windows may block microphone access by default. Go to **Settings > Privacy & security > Microphone** and ensure microphone access is enabled for desktop apps.

**Ollama: "Ollama is not running"**
Some Ollama installations start as a background service automatically. If you see this error, run `ollama serve` manually or check that the Ollama service is running.

**Whisper: "model not found"**
The whisper model file must be downloaded before first use. See [Whisper Model Setup](#whisper-model-setup) for instructions.

**Whisper: "installed but failed to load"**
The `@kutalia/whisper-node-addon` package is present but a native library it depends on is missing or incompatible on your system. The error includes the underlying loader message naming the library. Reinstalling the package will not help; resolve the named library instead.

## License

Apache-2.0. See [LICENSE](LICENSE) for details.

Copyright 2026 [Decibri](https://decibri.com)
