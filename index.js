#!/usr/bin/env node
'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const fs = require('fs');
const { version } = require('./package.json');
const { listDevices, captureAudio, getActiveMic } = require('./lib/audio');
const { transcribe } = require('./lib/transcribe');
const { chat } = require('./lib/llm');
const {
  validateListDevicesArgs,
  validateCaptureArgs,
  validateVoiceQueryArgs
} = require('./lib/validate');

// ── Server ─────────��───────────────────────��────────────────

// Tools only: no resources or resource templates are registered, and that
// is load-bearing. The SDK's resources/read path has carried a ReDoS
// advisory (GHSA-8r9q-7v3j-jr4g, patched in 1.25.2) that this server does
// not reach only because it registers no resources. Anyone adding a
// resource here must first confirm the SDK floor is current.
const server = new Server(
  { name: 'mcp-listen', version },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ───────────���────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_audio_devices',
      description: 'List available audio input devices (microphones) on this machine. Each device has a numeric index, a human-readable name, and a stable id. Prefer the id when selecting a device: indexes can shift when devices are added or removed, and names are not unique.',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
    },
    {
      name: 'capture_audio',
      description: 'Record audio from the microphone for a specified duration and save as a WAV file. Returns the file path and metadata.',
      inputSchema: {
        type: 'object',
        properties: {
          duration_ms: {
            type: 'number',
            description: 'Recording duration in milliseconds, 100-30000 (default: 5000)'
          },
          device: {
            type: ['number', 'string'],
            description: 'Device to record from: the numeric index or the stable string id, both reported by list_audio_devices. Prefer the id; indexes can shift when devices are added or removed. Omit for system default microphone.'
          }
        },
        required: [],
        additionalProperties: false
      }
    },
    {
      name: 'voice_query',
      description: 'Record audio from the microphone, transcribe speech to text using local whisper.cpp, send the transcription to a local Ollama LLM, and return the response. Fully offline.',
      inputSchema: {
        type: 'object',
        properties: {
          duration_ms: {
            type: 'number',
            description: 'Recording duration in milliseconds, 100-30000 (default: 5000)'
          },
          device: {
            type: ['number', 'string'],
            description: 'Device to record from: the numeric index or the stable string id, both reported by list_audio_devices. Prefer the id; indexes can shift when devices are added or removed. Omit for system default microphone.'
          },
          whisper_model: {
            type: 'string',
            description: 'Path or filename of Whisper GGML model (default: ggml-base.en.bin)'
          },
          language: {
            type: 'string',
            description: 'Language code for transcription (default: en)'
          },
          model: {
            type: 'string',
            description: 'Ollama model name (default: llama3.2)'
          },
          prompt: {
            type: 'string',
            description: 'System prompt for the LLM (default: You are a helpful assistant.)'
          }
        },
        required: [],
        additionalProperties: false
      }
    }
  ]
}));

// ── Tool execution ─────────────────��────────────────────────

// Arguments are validated before dispatch reaches any handler: the SDK
// only checks that arguments is a record, so the schema's types and
// ranges bind here, before anything is opened, allocated, or written.
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case 'list_audio_devices': {
      const v = validateListDevicesArgs(args);
      if (v.error) return v.error;
      return listDevices();
    }

    case 'capture_audio': {
      const v = validateCaptureArgs(args);
      if (v.error) return v.error;
      return captureAudio({
        durationMs: v.durationMs,
        device: v.device
      });
    }

    case 'voice_query': {
      const v = validateVoiceQueryArgs(args);
      if (v.error) return v.error;
      return voiceQuery(v);
    }

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true
      };
  }
});

// Takes the validated, normalized values from validateVoiceQueryArgs,
// never the raw request arguments.
async function voiceQuery(v) {
  // Step 1: Capture audio
  const captureResult = await captureAudio({
    durationMs: v.durationMs,
    device: v.device
  });

  if (captureResult.isError) return captureResult;

  let captureData;
  try {
    captureData = JSON.parse(captureResult.content[0].text);
  } catch {
    return {
      content: [{ type: 'text', text: 'Error: Failed to parse capture result.' }],
      isError: true
    };
  }
  const wavPath = captureData.path;

  try {
    // Step 2: Transcribe
    const transcribeResult = await transcribe({
      filePath: wavPath,
      modelPath: v.whisperModel,
      language: v.language
    });

    if (transcribeResult.error) {
      return {
        content: [{ type: 'text', text: transcribeResult.error }],
        isError: true
      };
    }

    if (!transcribeResult.transcription) {
      return {
        content: [{ type: 'text', text: 'Transcription returned empty result. No speech detected.' }],
        isError: true
      };
    }

    // Step 3: Send to LLM
    const llmResult = await chat({
      text: transcribeResult.transcription,
      model: v.model,
      systemPrompt: v.prompt
    });

    if (llmResult.error) {
      return {
        content: [{ type: 'text', text: llmResult.error }],
        isError: true
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          transcription: transcribeResult.transcription,
          response: llmResult.response,
          model: llmResult.model
        }, null, 2)
      }]
    };
  } finally {
    // Clean up temp WAV file
    await fs.promises.unlink(wavPath).catch(() => {});
  }
}

// ── Graceful shutdown ───────────────────────────────────────

async function shutdown() {
  const mic = getActiveMic();
  if (mic && mic.isOpen) mic.stop();
  await server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Start ──────────────���────────────────────────────────────

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('mcp-listen server started');
})().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
