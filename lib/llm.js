'use strict';

// Optional dependency: a load failure must not stop the server, so it
// degrades to an error result at call time. The caught error is kept
// because "not installed" and "installed but failed to load" demand
// different actions: only a MODULE_NOT_FOUND naming the package itself
// is fixed by npm install; any other failure needs the underlying error.
// Same reasoning as the whisper addon handling in lib/transcribe.js.
let Ollama = null;
let ollamaLoadError = null;
try {
  ({ Ollama } = require('ollama'));
} catch (err) {
  ollamaLoadError = err;
}

function isNotInstalled(err) {
  return err.code === 'MODULE_NOT_FOUND' &&
    typeof err.message === 'string' &&
    err.message.includes("'ollama'");
}

const REQUEST_TIMEOUT_MS = 60000;

function isConnectionError(err) {
  const codes = ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ETIMEDOUT'];
  if (err.code && codes.includes(err.code)) return true;
  if (err.cause) return isConnectionError(err.cause);
  if (err.message && /connect|refused|unreachable/i.test(err.message)) return true;
  return false;
}

async function chat({ text, model = 'llama3.2', systemPrompt = 'You are a helpful assistant.', host } = {}) {
  if (!Ollama) {
    if (ollamaLoadError && !isNotInstalled(ollamaLoadError)) {
      return {
        error: `ollama package is installed but failed to load: ${ollamaLoadError.message}.`,
        cause: ollamaLoadError
      };
    }
    return {
      error: 'ollama package is not installed. Install it with: npm install ollama',
      cause: ollamaLoadError
    };
  }

  const options = {};
  if (host) options.host = host;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const ollama = new Ollama(options);
    const result = await ollama.chat({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ],
      signal: controller.signal
    });

    return {
      response: result.message.content,
      model
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { error: `Ollama request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.` };
    }
    if (isConnectionError(err)) {
      return { error: 'Ollama is not running. Start it with: ollama serve' };
    }
    if (err.message && err.message.includes('not found')) {
      return { error: `Model "${model}" not found. Pull it with: ollama pull ${model}` };
    }
    return { error: `LLM error: ${err.message}` };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { chat };
