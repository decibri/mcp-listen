'use strict';

// Argument validation for the tool handlers. The SDK validates tool
// arguments only as a record of unknowns; it does not enforce the declared
// input schema, so every constraint the schemas state (types, the
// duration range, additionalProperties: false) is enforced here instead.
// Runs before anything is opened, allocated, or written: a rejected call
// must never reach the audio layer or the filesystem.
//
// Policy for absent values: null and undefined both select the documented
// default. MCP clients write null for "no preference" (the SDK does not
// reject it), and decibri itself maps a null device to the system default,
// so treating null as "not provided" is the only reading that cannot
// surprise either side. Every other type mismatch is an error that names
// the parameter, shows what was received, and states what is accepted.

const MIN_DURATION_MS = 100;
const MAX_DURATION_MS = 30000;

// Render a received value for an error message: bounded length, and typed
// so that "500" (a string) cannot be misread as the number 500.
function received(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') {
    const shown = value.length > 60
      ? JSON.stringify(value.slice(0, 57)) + '...'
      : JSON.stringify(value);
    return `${shown} (a string)`;
  }
  if (t === 'number' || t === 'boolean' || t === 'bigint') return `${String(value)} (a ${t})`;
  if (Array.isArray(value)) return 'an array';
  if (t === 'object') return 'an object';
  return `a ${t}`;
}

function fail(text) {
  return { error: { content: [{ type: 'text', text }], isError: true } };
}

// The declared schemas state additionalProperties: false; nothing enforces
// it, so an unknown argument is otherwise ignored silently. That is worse
// than an error: a caller sending output_path would be told nothing and
// left believing it was honoured.
function checkUnknownKeys(args, allowed, toolName) {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      return fail(
        `Error: unknown argument "${key}" for ${toolName}. ` +
        `Accepted arguments: ${allowed.length > 0 ? allowed.join(', ') : 'none'}.`
      );
    }
  }
  return null;
}

function checkDuration(value) {
  if (value === undefined || value === null) return { durationMs: undefined };
  if (typeof value !== 'number') {
    return fail(
      `Error: duration_ms must be a number. Got: ${received(value)}. ` +
      `Provide an integer number of milliseconds between ${MIN_DURATION_MS} and ${MAX_DURATION_MS}.`
    );
  }
  if (!Number.isFinite(value)) {
    return fail(
      `Error: duration_ms must be a finite number. Got: ${String(value)}. ` +
      `Provide an integer number of milliseconds between ${MIN_DURATION_MS} and ${MAX_DURATION_MS}.`
    );
  }
  if (!Number.isInteger(value)) {
    return fail(
      `Error: duration_ms must be an integer. Got: ${String(value)}. ` +
      `Provide a whole number of milliseconds between ${MIN_DURATION_MS} and ${MAX_DURATION_MS}.`
    );
  }
  if (value < MIN_DURATION_MS || value > MAX_DURATION_MS) {
    return fail(`Error: duration_ms must be between ${MIN_DURATION_MS} and ${MAX_DURATION_MS}. Got: ${value}`);
  }
  return { durationMs: value };
}

function checkDevice(value) {
  if (value === undefined || value === null) return { device: undefined };
  if (typeof value === 'number') {
    // Whether the index exists is decibri's call at open time; that a
    // selector like NaN, 1.5, or -1 can never name a device is decided
    // here, before anything is opened.
    if (!Number.isInteger(value) || value < 0) {
      return fail(
        `Error: device index must be a non-negative integer. Got: ${String(value)}. ` +
        `Use the index reported by list_audio_devices.`
      );
    }
    return { device: value };
  }
  if (typeof value === 'string') {
    if (value.length === 0) {
      return fail(
        `Error: device id must be a non-empty string. ` +
        `Use the id reported by list_audio_devices.`
      );
    }
    return { device: value };
  }
  return fail(
    `Error: device must be a number (device index) or a string (device id). Got: ${received(value)}. ` +
    `Use the index or id reported by list_audio_devices, or omit for the system default microphone.`
  );
}

function checkOptionalString(name, value, expected) {
  if (value === undefined || value === null) return { value: undefined };
  if (typeof value !== 'string') {
    return fail(`Error: ${name} must be a string (${expected}). Got: ${received(value)}.`);
  }
  return { value };
}

function validateListDevicesArgs(args) {
  return checkUnknownKeys(args, [], 'list_audio_devices') || {};
}

function validateCaptureArgs(args) {
  const unknown = checkUnknownKeys(args, ['duration_ms', 'device'], 'capture_audio');
  if (unknown) return unknown;

  const duration = checkDuration(args.duration_ms);
  if (duration.error) return duration;
  const device = checkDevice(args.device);
  if (device.error) return device;

  return { durationMs: duration.durationMs, device: device.device };
}

function validateVoiceQueryArgs(args) {
  const unknown = checkUnknownKeys(
    args,
    ['duration_ms', 'device', 'whisper_model', 'language', 'model', 'prompt'],
    'voice_query'
  );
  if (unknown) return unknown;

  const duration = checkDuration(args.duration_ms);
  if (duration.error) return duration;
  const device = checkDevice(args.device);
  if (device.error) return device;

  const whisperModel = checkOptionalString('whisper_model', args.whisper_model, 'path or filename of a Whisper GGML model');
  if (whisperModel.error) return whisperModel;
  const language = checkOptionalString('language', args.language, 'a language code, such as "en"');
  if (language.error) return language;
  const model = checkOptionalString('model', args.model, 'an Ollama model name');
  if (model.error) return model;
  const prompt = checkOptionalString('prompt', args.prompt, 'a system prompt for the LLM');
  if (prompt.error) return prompt;

  return {
    durationMs: duration.durationMs,
    device: device.device,
    whisperModel: whisperModel.value,
    language: language.value,
    model: model.value,
    prompt: prompt.value
  };
}

module.exports = {
  MIN_DURATION_MS,
  MAX_DURATION_MS,
  validateListDevicesArgs,
  validateCaptureArgs,
  validateVoiceQueryArgs
};
