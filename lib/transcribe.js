'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// The addon is an optional dependency: a load failure must not stop the
// server (the capture tools work without it), so it degrades to an error
// result at call time. The caught error is kept, not discarded, because
// "not installed" and "installed but failed to load" demand opposite
// actions from the user: a genuine MODULE_NOT_FOUND for the addon itself
// means npm install fixes it, while a load failure on an installed addon
// (for example a missing system library such as libwhisper.so.1) means
// npm install is already satisfied and only the underlying loader error
// says what is actually wrong. Same reasoning as the decibri loader
// handling in lib/audio.js.
let whisper = null;
let whisperLoadError = null;
try {
  whisper = require('@kutalia/whisper-node-addon');
} catch (err) {
  whisperLoadError = err;
}

// A MODULE_NOT_FOUND naming the addon itself is the not-installed state.
// A MODULE_NOT_FOUND for anything else (a file inside the addon, one of
// its dependencies) means the addon is present but broken, which is a
// load failure, not an install gap.
function isNotInstalled(err) {
  return err.code === 'MODULE_NOT_FOUND' &&
    typeof err.message === 'string' &&
    err.message.includes("'@kutalia/whisper-node-addon'");
}

const DEFAULT_MODEL = 'ggml-base.en.bin';

function resolveModelPath(modelPath) {
  // If absolute path provided, use it directly
  if (modelPath && path.isAbsolute(modelPath)) {
    return fs.existsSync(modelPath) ? modelPath : null;
  }

  const modelName = modelPath || DEFAULT_MODEL;
  const searchPaths = [];

  // 1. WHISPER_MODEL_PATH env var
  if (process.env.WHISPER_MODEL_PATH) {
    searchPaths.push(path.join(process.env.WHISPER_MODEL_PATH, modelName));
  }

  // 2. ~/.mcp-listen/models/
  searchPaths.push(path.join(os.homedir(), '.mcp-listen', 'models', modelName));

  // 3. Current working directory
  searchPaths.push(path.join(process.cwd(), modelName));

  for (const p of searchPaths) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

async function transcribe({ filePath, modelPath, language = 'en' } = {}) {
  if (!whisper) {
    if (whisperLoadError && !isNotInstalled(whisperLoadError)) {
      return {
        error: '@kutalia/whisper-node-addon is installed but failed to load: ' +
          `${whisperLoadError.message}. ` +
          'This usually means a native library it depends on is missing or incompatible on this system.',
        cause: whisperLoadError
      };
    }
    return {
      error: '@kutalia/whisper-node-addon is not installed. Install it with: npm install @kutalia/whisper-node-addon',
      cause: whisperLoadError
    };
  }

  const resolvedModel = resolveModelPath(modelPath);
  if (!resolvedModel) {
    const modelName = modelPath || DEFAULT_MODEL;
    const modelsDir = path.join(os.homedir(), '.mcp-listen', 'models');
    return {
      error: `Whisper model "${modelName}" not found. Download it:\n` +
        `  mkdir -p ${modelsDir}\n` +
        `  curl -L -o ${path.join(modelsDir, modelName)} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelName}`
    };
  }

  try {
    const result = await whisper.transcribe({
      fname_inp: filePath,
      model: resolvedModel,
      language
    });

    if (!result || !Array.isArray(result.transcription)) {
      return { error: 'Unexpected whisper response format. Expected { transcription: [] }.' };
    }

    const text = result.transcription
      .map(segment => {
        if (typeof segment === 'string') return segment;
        if (Array.isArray(segment) && typeof segment[2] === 'string') return segment[2];
        return '';
      })
      .join(' ')
      .trim();

    return { transcription: text };
  } catch (err) {
    return { error: `Transcription failed: ${err.message}` };
  }
}

module.exports = { transcribe };
