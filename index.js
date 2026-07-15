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
const { sweepStaleRecordings } = require('./lib/cleanup');
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
      description: 'Record audio from the microphone for a specified duration, or until the speaker stops talking with stop_on_silence, and save as a WAV file. Returns the file path and metadata.',
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
          stop_on_silence: {
            type: 'boolean',
            description: 'Stop recording when the speaker stops talking, detected with on-device voice activity detection. When true, duration_ms becomes a maximum rather than an exact length: recording ends after silence_ms of continuous silence once speech has been heard, at the duration_ms ceiling, or 10 seconds in if speech never starts (the result then reports speech_detected: false). Default: false (record for exactly duration_ms).'
          },
          silence_ms: {
            type: 'number',
            description: 'Continuous silence in milliseconds that ends a stop_on_silence recording, 100-10000 (default: 1000). Detection runs per ~100ms audio buffer, so the effective hangover rounds up to the next buffer. Requires stop_on_silence: true.'
          }
        },
        required: [],
        additionalProperties: false
      }
    },
    {
      name: 'voice_query',
      description: 'Record audio from the microphone, transcribe speech to text using local whisper.cpp, send the transcription to a local Ollama LLM, and return the response. Recording stops automatically when the speaker stops talking. Fully offline.',
      inputSchema: {
        type: 'object',
        properties: {
          duration_ms: {
            type: 'number',
            description: 'Maximum recording duration in milliseconds, 100-30000 (default: 15000 while stop_on_silence is active, 5000 for a fixed-length recording). While stop_on_silence is active, recording usually ends earlier, when the speaker stops talking.'
          },
          device: {
            type: ['number', 'string'],
            description: 'Device to record from: the numeric index or the stable string id, both reported by list_audio_devices. Prefer the id; indexes can shift when devices are added or removed. Omit for system default microphone.'
          },
          stop_on_silence: {
            type: 'boolean',
            description: 'Stop recording when the speaker stops talking (default: true). Recording ends after silence_ms of continuous silence once speech has been heard, at the duration_ms ceiling, or 10 seconds in if speech never starts. Pass false to record for exactly duration_ms instead.'
          },
          silence_ms: {
            type: 'number',
            description: 'Continuous silence in milliseconds that ends the recording, 100-10000 (default: 1000). Detection runs per ~100ms audio buffer, so the effective hangover rounds up to the next buffer. Only meaningful while stop_on_silence is active (the default).'
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
        device: v.device,
        stopOnSilence: v.stopOnSilence,
        silenceMs: v.silenceMs
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

// Whisper returns non-speech markers as ordinary non-empty strings:
// [BLANK_AUDIO], [ MUSIC ], (silence), [SOUND], musical-note glyphs, or bare
// punctuation on silent or noisy audio. These are not words. Left unchecked
// they flow to the LLM as the user's query, and the model answers a marker
// as though it were a real question, fabricating a response to input the
// user never gave.
//
// A transcription has usable words only if, after removing every bracketed
// [..] and parenthesised (..) marker, at least one letter or digit (in any
// script) remains. This is deliberately conservative: real speech always
// carries a bare word outside any marker, so a genuine transcription is
// never discarded, even one that merely contains a bracketed word ("I heard
// a [beep] sound" keeps "I heard a sound" and is treated as real). Only a
// string that is entirely markers, symbols, or whitespace collapses to
// nothing and is treated as no usable words. The bracket/paren removal is
// content-agnostic, so it needs no token list and is inherently
// case-insensitive and spacing-tolerant ([BLANK_AUDIO], [ blank_audio ],
// [Music] all collapse).
function hasUsableWords(text) {
  if (typeof text !== 'string') return false;
  const withoutMarkers = text
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^)]*\)/g, '');
  return /[\p{L}\p{N}]/u.test(withoutMarkers);
}

// Takes the validated, normalized values from validateVoiceQueryArgs,
// never the raw request arguments.
async function voiceQuery(v) {
  // voice_query stops on silence by default: its only consumer is speech
  // transcription, and a spoken query has no known length, so a fixed
  // window is wrong in both directions (it truncates long questions and
  // records silence after short ones). An explicit stop_on_silence: false
  // restores the fixed window. The default ceiling is raised to 15s in
  // silence mode because it is a bound, not the expected length; the
  // fixed-window default stays 5s exactly as before.
  const stopOnSilence = v.stopOnSilence !== undefined ? v.stopOnSilence : true;
  const durationMs = v.durationMs !== undefined
    ? v.durationMs
    : (stopOnSilence ? 15000 : undefined);

  // Step 1: Capture audio
  const captureResult = await captureAudio({
    durationMs,
    device: v.device,
    stopOnSilence,
    silenceMs: v.silenceMs
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
    // A capture that heard no speech has nothing to transcribe. Silence is
    // a correct observation, not a tool failure, so this is a non-error
    // result, the same way capture_audio reports the identical event: the
    // machine-readable contract is the boolean speech_detected: false (and
    // the stopped_by that capture_audio already carries), never the prose,
    // so a caller branches on the field and the message wording can change
    // without breaking anyone. whisper is skipped deliberately: it
    // hallucinates text on silent input, so running it here would fabricate
    // a transcription. transcription and response are null because the
    // pipeline stopped before producing them.
    if (captureData.speech_detected === false) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            speech_detected: false,
            stopped_by: captureData.stopped_by,
            transcription: null,
            response: null,
            message: 'No speech was detected. Ask the user to repeat, or check that the correct microphone is selected.'
          }, null, 2)
        }]
      };
    }

    // Step 2: Transcribe
    const transcribeResult = await transcribe({
      filePath: wavPath,
      modelPath: v.whisperModel,
      language: v.language
    });

    // Event 3: the transcription step could not run (addon missing, native
    // load failure, missing model, unexpected response, or a runtime throw).
    // The machinery broke, so this is an error, and transcribeResult.error
    // already names the real cause; surface it unchanged.
    if (transcribeResult.error) {
      return {
        content: [{ type: 'text', text: transcribeResult.error }],
        isError: true
      };
    }

    // Event 2: whisper ran but produced no usable words, either an empty
    // string or a non-speech marker such as [BLANK_AUDIO]. The pipeline
    // worked and found nothing to say, so this is a success, not a failure,
    // and it must NOT reach the LLM. It is distinguished from event 1 (no
    // speech at all) by speech_detected, which is passed through from the
    // capture: true when the VAD heard speech, absent in a fixed-window
    // capture where no VAD ran.
    if (!hasUsableWords(transcribeResult.transcription)) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            speech_detected: captureData.speech_detected,
            stopped_by: captureData.stopped_by,
            transcription: null,
            response: null,
            message: 'Speech was detected but could not be transcribed. It may have been too quiet, too brief, or unclear. Ask the user to repeat, a little louder and closer to the microphone.'
          }, null, 2)
        }]
      };
    }

    // Step 3: Send to LLM
    const llmResult = await chat({
      text: transcribeResult.transcription,
      model: v.model,
      systemPrompt: v.prompt
    });

    // Event 4: the LLM dependency could not be reached or errored (daemon
    // down, model missing, timeout). Its machinery broke, so this is an
    // error, and llmResult.error names the real cause; surface it unchanged.
    if (llmResult.error) {
      return {
        content: [{ type: 'text', text: llmResult.error }],
        isError: true
      };
    }

    // Event 5: transcription succeeded and the LLM ran but returned nothing.
    // Distinct from event 4 (the LLM never produced a result): here a valid
    // transcription exists, so it is attached, letting a caller see what was
    // heard even though the model said nothing. Reported as an error because
    // the request did not produce the answer it was asked for.
    if (!llmResult.response || !llmResult.response.trim()) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            transcription: transcribeResult.transcription,
            response: null,
            model: llmResult.model,
            message: 'Transcription succeeded but the language model returned an empty response.'
          }, null, 2)
        }],
        isError: true
      };
    }

    // Normal: a real transcription and a real answer.
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

// Start the server only when run as the entry point (node index.js, or the
// mcp-listen bin), not when required. Requiring this module in a test loads
// the tool handlers and voiceQuery without connecting a transport, so the
// no-speech pipeline logic can be exercised against a stubbed microphone
// with no stdio server attached. Production behaviour is unchanged: the bin
// is always run directly, so this branch always fires there.
if (require.main === module) {
  (async () => {
    // Not awaited: the sweep is best-effort housekeeping and must never
    // delay or prevent the server coming up.
    sweepStaleRecordings();

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('mcp-listen server started');
  })().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

// Exported for testing only. voiceQuery is the pipeline behind the
// voice_query tool; the no-speech short-circuit is covered deterministically
// by driving it against a stubbed microphone (see test/stub-vad-timeline.js).
module.exports = { voiceQuery };
