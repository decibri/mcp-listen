<!-- markdownlint-disable MD033 MD041 -->

# mcp-listen

**Give your AI agents the ability to listen**

Microphone capture and speech-to-text tools for MCP-compatible agents.

<div>
  <!-- badges: start -->
  <table>
    <tr>
      <td><strong>Meta</strong></td>
      <td>
        <a href="https://www.npmjs.com/package/mcp-listen"><img src="https://img.shields.io/npm/v/mcp-listen" alt="npm version"></a>&nbsp;
        <a href="https://github.com/decibri/mcp-listen/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="Apache 2.0 License"></a>&nbsp;
      </td>
    </tr>
    <tr>
      <td><strong>Powered by</strong></td>
      <td>
        <a href="https://decibri.com"><img src="https://img.shields.io/badge/decibri-audio_capture-brightgreen" alt="decibri"></a>&nbsp;
        <a href="https://voxagent.run"><img src="https://img.shields.io/badge/voxagent-voice_pipeline-brightgreen" alt="voxagent"></a>
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

**For `list_audio_devices` and `capture_audio`:**

- Node.js 18+
- A microphone

**For `voice_query` (optional):**

- [Ollama](https://ollama.com) running locally
- Whisper GGML model (see [Whisper Model Setup](#whisper-model-setup))

## Tool Reference

### list_audio_devices

Returns a JSON array of available audio input devices.

**Parameters:** None

**Example response:**

```json
[
  { "index": 3, "name": "Microphone (Creative Live! Cam)", "isDefault": true, "maxInputChannels": 2, "defaultSampleRate": 48000 },
  { "index": 4, "name": "Microphone Array (Intel)", "isDefault": false, "maxInputChannels": 2, "defaultSampleRate": 48000 }
]
```

### capture_audio

Records audio from the microphone and saves as a WAV file.

**Parameters:**

| Parameter | Type | Default | Description |
| ---------- | ------ | --------- | ------------- |
| `duration_ms` | number | 5000 | Recording duration in milliseconds (100-30000) |
| `device` | number | system default | Device index from `list_audio_devices` |

**Example response:**

```json
{
  "path": "/tmp/mcp-listen-1712345678901.wav",
  "duration_ms": 5000,
  "sample_rate": 16000,
  "channels": 1,
  "size_bytes": 160044
}
```

### voice_query

Full voice pipeline: capture audio, transcribe with whisper.cpp, send to Ollama, return the response. Entirely offline.

**Parameters:**

| Parameter | Type | Default | Description |
| ----------- | ------ | --------- | ------------- |
| `duration_ms` | number | 5000 | Recording duration in milliseconds (100-30000) |
| `device` | number | system default | Device index from `list_audio_devices` |
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

## How It Works

mcp-listen uses [decibri](https://decibri.com) for cross-platform microphone capture. No ffmpeg, no SoX, no system audio tools required. Pre-built native binaries with zero setup.

Audio is captured as 16-bit PCM at 16kHz mono, the standard format for speech-to-text engines.

The `voice_query` tool replicates the pipeline from [voxagent](https://voxagent.run): capture audio, transcribe locally with whisper.cpp, and send to a local Ollama LLM. Fully offline, nothing leaves your machine.

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

1. **Fixed recording duration.** You specify how long to record. There is no "stop when I stop talking" mode yet.
2. **`voice_query` requires Ollama running.** If Ollama isn't running, the tool returns a clear error message.
3. **Whisper model downloads on first use.** The first `voice_query` call requires a pre-downloaded model (~150MB).
4. **No streaming.** MCP's request/response pattern means the entire recording is captured, then transcribed, then sent to the LLM. No real-time partial results.
5. **Temp files.** `capture_audio` writes WAV files to the system temp directory. They are not automatically cleaned up. `voice_query` cleans up after itself.

## Troubleshooting

**Windows: "Error opening microphone"**
Windows may block microphone access by default. Go to **Settings > Privacy & security > Microphone** and ensure microphone access is enabled for desktop apps.

**Ollama: "Ollama is not running"**
Some Ollama installations start as a background service automatically. If you see this error, run `ollama serve` manually or check that the Ollama service is running.

**Whisper: "model not found"**
The whisper model file must be downloaded before first use. See [Whisper Model Setup](#whisper-model-setup) for instructions.

## Powered By

- [decibri](https://decibri.com): Cross-platform microphone capture for Node.js
- [voxagent](https://voxagent.run): Voice-powered terminal agent (inspiration for the voice_query pipeline)

## License

Apache-2.0. See [LICENSE](LICENSE) for details.

Copyright 2026 [Decibri](https://decibri.com)

