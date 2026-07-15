'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { version } = require('../package.json');

const SERVER_PATH = path.join(__dirname, '..', 'index.js');
const STARTUP_DELAY = 1000;
const RESPONSE_TIMEOUT = 15000;

let passed = 0;
let failed = 0;
let skipped = 0;
let msgId = 0;

function log(status, name) {
  const symbol = status === 'pass' ? '\x1b[32mPASS\x1b[0m' : status === 'fail' ? '\x1b[31mFAIL\x1b[0m' : '\x1b[33mSKIP\x1b[0m';
  console.log(`  ${symbol}  ${name}`);
}

// Capture through the server with the given extra arguments and assert the
// WAV is byte-exact for the tool's fixed output format at the requested
// duration (default 500ms). Returns the file size. Used by the by-index and
// by-id device selection tests and the fixed-path duration checks; the main
// capture test (test 4) keeps its own full set of header assertions.
async function captureExact(server, extraArgs, durationMs = 500) {
  const SAMPLE_RATE = 16000;
  const CHANNELS = 1;
  const BIT_DEPTH = 16;
  const WAV_HEADER_BYTES = 44;
  const expectedPcmBytes =
    Math.round((durationMs * SAMPLE_RATE) / 1000) * CHANNELS * (BIT_DEPTH / 8);
  const expectedSize = WAV_HEADER_BYTES + expectedPcmBytes;

  const res = await server.send('tools/call', {
    name: 'capture_audio',
    arguments: { duration_ms: durationMs, ...extraArgs }
  });
  if (res.result.isError) throw new Error(res.result.content[0].text);
  const data = JSON.parse(res.result.content[0].text);
  const stat = fs.statSync(data.path);
  try { fs.unlinkSync(data.path); } catch {}
  if (stat.size !== expectedSize) {
    throw new Error(`Expected exactly ${expectedSize} bytes for ${durationMs}ms, got ${stat.size}`);
  }
  return stat.size;
}

function startServer() {
  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let buffer = '';
  const pending = new Map();

  child.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { resolve, timer } = pending.get(msg.id);
          clearTimeout(timer);
          pending.delete(msg.id);
          resolve(msg);
        }
      } catch {}
    }
  });

  function send(method, params = {}, timeoutMs = RESPONSE_TIMEOUT) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  function notify(method, params = {}) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  function kill() {
    child.kill();
  }

  return { send, notify, kill, child };
}

async function run() {
  console.log('\nmcp-listen smoke tests\n');

  const server = startServer();
  await new Promise(r => setTimeout(r, STARTUP_DELAY));

  // Test 1: Server initializes
  try {
    const res = await server.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0' }
    });
    server.notify('notifications/initialized');

    const info = res.result.serverInfo;
    if (info.name !== 'mcp-listen') throw new Error(`Expected name 'mcp-listen', got '${info.name}'`);
    if (info.version !== version) throw new Error(`Expected version '${version}', got '${info.version}'`);
    log('pass', `Server initializes (${info.name} v${info.version})`);
    passed++;
  } catch (err) {
    log('fail', `Server initializes: ${err.message}`);
    failed++;
    server.kill();
    return;
  }

  // Test 2: All 3 tools advertised, each with a strict input schema. The
  // SDK does not enforce the input schema at the transport layer, so the
  // schema is the only place undeclared arguments can be rejected, and only
  // by a validating client or layer. That makes additionalProperties: false
  // and an explicit required array part of the tool contract: every schema
  // must declare both, even when required is empty.
  try {
    const res = await server.send('tools/list', {});
    const names = res.result.tools.map(t => t.name).sort();
    const expected = ['capture_audio', 'list_audio_devices', 'voice_query'];
    if (JSON.stringify(names) !== JSON.stringify(expected)) {
      throw new Error(`Expected tools ${expected}, got ${names}`);
    }
    for (const tool of res.result.tools) {
      const schema = tool.inputSchema;
      if (!schema || schema.type !== 'object') {
        throw new Error(`${tool.name}: inputSchema must be an object schema`);
      }
      if (schema.additionalProperties !== false) {
        throw new Error(`${tool.name}: inputSchema must declare additionalProperties: false`);
      }
      if (!Array.isArray(schema.required)) {
        throw new Error(`${tool.name}: inputSchema must declare an explicit required array`);
      }
      // The silence-stopped mode is part of the advertised contract on both
      // capture tools; a schema that stops declaring it would silently
      // remove the capability from every schema-reading client.
      if (tool.name === 'capture_audio' || tool.name === 'voice_query') {
        for (const key of ['stop_on_silence', 'silence_ms']) {
          if (!schema.properties || !schema.properties[key]) {
            throw new Error(`${tool.name}: inputSchema must declare ${key}`);
          }
        }
      }
    }
    log('pass', 'All 3 tools advertised with strict input schemas');
    passed++;
  } catch (err) {
    log('fail', `All 3 tools advertised: ${err.message}`);
    failed++;
  }

  // Test 3: list_audio_devices returns valid response
  let hasDevices = false;
  let deviceList = [];
  try {
    const res = await server.send('tools/call', { name: 'list_audio_devices', arguments: {} });
    const text = res.result.content[0].text;
    const parsed = JSON.parse(text);

    if (parsed.devices && parsed.devices.length === 0) {
      hasDevices = false;
      log('pass', 'list_audio_devices returns empty (no mic detected)');
    } else if (Array.isArray(parsed)) {
      hasDevices = parsed.length > 0;
      deviceList = parsed;
      if (hasDevices && typeof parsed[0].name !== 'string') {
        throw new Error('Device object missing name field');
      }
      log('pass', `list_audio_devices returns ${parsed.length} device(s)`);
    } else {
      throw new Error('Unexpected response format');
    }
    passed++;
  } catch (err) {
    log('fail', `list_audio_devices: ${err.message}`);
    failed++;
  }

  // Test 4: capture_audio on the default path. When a device is flagged
  // default, it must deliver the requested duration of PCM, exactly: the
  // WAV must be byte-exact for the requested duration at the tool's fixed
  // output format, and the header must declare that format. This cannot
  // distinguish silence from signal; it verifies the delivery contract,
  // not audio content. (The no-flagged-default branch follows below.)
  if (hasDevices && deviceList.some((d) => d.isDefault)) {
    try {
      const DURATION_MS = 500;
      // The tool's fixed output format (mirrors lib/audio.js). The header
      // assertions below verify the produced WAV actually declares it.
      const SAMPLE_RATE = 16000;
      const CHANNELS = 1;
      const BIT_DEPTH = 16;
      const WAV_HEADER_BYTES = 44;
      const expectedPcmBytes =
        Math.round((DURATION_MS * SAMPLE_RATE) / 1000) * CHANNELS * (BIT_DEPTH / 8);
      const expectedSize = WAV_HEADER_BYTES + expectedPcmBytes;

      const res = await server.send('tools/call', {
        name: 'capture_audio',
        arguments: { duration_ms: DURATION_MS }
      });
      if (res.result.isError) throw new Error(res.result.content[0].text);
      const data = JSON.parse(res.result.content[0].text);
      if (!data.path) throw new Error('No path in response');
      if (!fs.existsSync(data.path)) throw new Error(`File not found: ${data.path}`);

      const header = Buffer.alloc(WAV_HEADER_BYTES);
      const fd = fs.openSync(data.path, 'r');
      fs.readSync(fd, header, 0, WAV_HEADER_BYTES, 0);
      fs.closeSync(fd);
      if (header.toString('ascii', 0, 4) !== 'RIFF') throw new Error('File does not start with RIFF header');

      const headerChannels = header.readUInt16LE(22);
      const headerSampleRate = header.readUInt32LE(24);
      const headerBitDepth = header.readUInt16LE(34);
      const headerDataSize = header.readUInt32LE(40);
      if (headerChannels !== CHANNELS) throw new Error(`Header channels: expected ${CHANNELS}, got ${headerChannels}`);
      if (headerSampleRate !== SAMPLE_RATE) throw new Error(`Header sample rate: expected ${SAMPLE_RATE}, got ${headerSampleRate}`);
      if (headerBitDepth !== BIT_DEPTH) throw new Error(`Header bit depth: expected ${BIT_DEPTH}, got ${headerBitDepth}`);
      if (headerDataSize !== expectedPcmBytes) throw new Error(`Header data size: expected ${expectedPcmBytes}, got ${headerDataSize}`);

      const stat = fs.statSync(data.path);
      if (stat.size !== expectedSize) {
        throw new Error(`Expected exactly ${expectedSize} bytes for ${DURATION_MS}ms, got ${stat.size}`);
      }

      // Clean up test file
      try { fs.unlinkSync(data.path); } catch {}

      log('pass', `capture_audio delivers ${DURATION_MS}ms of PCM exactly (${stat.size} bytes)`);
      passed++;
    } catch (err) {
      log('fail', `capture_audio: ${err.message}`);
      failed++;
    }
  } else if (hasDevices) {
    // Devices exist but none is flagged default. Two legitimate outcomes,
    // and nothing else: the tool refuses or fails with the actionable
    // no-usable-default error (headless machines, where the only device is
    // the ALSA null device or the phantom default does not open), or the
    // capture succeeds byte-exactly through a working default the host does
    // not flag (a custom ALSA configuration). A misleading error or a
    // short WAV fails either way.
    try {
      const DURATION_MS = 500;
      const expectedSize = 44 + Math.round((DURATION_MS * 16000) / 1000) * 2;
      const res = await server.send('tools/call', {
        name: 'capture_audio',
        arguments: { duration_ms: DURATION_MS }
      });
      if (res.result.isError) {
        const text = res.result.content[0].text;
        if (!text.includes('no usable default input device')) {
          throw new Error(`Expected the actionable no-default error, got: ${text}`);
        }
        if (!text.includes('list_audio_devices')) {
          throw new Error(`Error must point at list_audio_devices, got: ${text}`);
        }
        // The silence-stopped mode must hit the same guards in the same
        // order: a machine with no usable default refuses before any VAD
        // model is loaded, with the same actionable error.
        const silenceRes = await server.send('tools/call', {
          name: 'capture_audio',
          arguments: { duration_ms: DURATION_MS, stop_on_silence: true }
        });
        if (!silenceRes.result.isError ||
            !silenceRes.result.content[0].text.includes('no usable default input device')) {
          throw new Error(`silence-stopped capture must be refused identically, got: ${silenceRes.result.content[0].text}`);
        }
        log('pass', 'default capture returns actionable error (no default device, both modes)');
      } else {
        const data = JSON.parse(res.result.content[0].text);
        const stat = fs.statSync(data.path);
        try { fs.unlinkSync(data.path); } catch {}
        if (stat.size !== expectedSize) {
          throw new Error(`Expected exactly ${expectedSize} bytes for ${DURATION_MS}ms, got ${stat.size}`);
        }
        log('pass', `default capture byte-exact via unflagged default (${stat.size} bytes)`);
      }
      passed++;
    } catch (err) {
      log('fail', `default capture (no flagged default): ${err.message}`);
      failed++;
    }
  } else {
    log('skip', 'capture_audio (no microphone available)');
    skipped++;
  }

  // Fixed path at a second duration: 2000ms must be byte-exact too. Two
  // points pin the arithmetic as linear in the duration; a single duration
  // could pass with a compensating constant error.
  if (hasDevices && deviceList.some((d) => d.isDefault)) {
    try {
      const size = await captureExact(server, {}, 2000);
      log('pass', `capture_audio 2000ms fixed path is byte-exact (${size} bytes)`);
      passed++;
    } catch (err) {
      log('fail', `capture_audio 2000ms fixed path: ${err.message}`);
      failed++;
    }
  } else {
    log('skip', 'capture_audio 2000ms fixed path (no default device)');
    skipped++;
  }

  // Live silence-stopped capture. The stop logic itself is pinned
  // deterministically by test/stub-vad-timeline.js; what only a live run
  // can prove is the native stack under it: the bundled ONNX Runtime
  // loads, the Silero model loads, and inference runs on real captured
  // audio. The terminal state depends on the room: a silent machine (and
  // the virtual device on a bare runner) ends at the 10s no-speech
  // backstop, byte-exact; ambient speech ends it at 'silence' or
  // 'ceiling'. Every branch must satisfy the same exact size/header
  // relations; the no-speech branch is additionally byte-exact at 320044.
  if (hasDevices && deviceList.some((d) => d.isDefault)) {
    try {
      const res = await server.send('tools/call', {
        name: 'capture_audio',
        arguments: { duration_ms: 12000, stop_on_silence: true }
      }, 25000);
      if (res.result.isError) throw new Error(res.result.content[0].text);
      const data = JSON.parse(res.result.content[0].text);
      if (!['silence', 'ceiling', 'no_speech_timeout'].includes(data.stopped_by)) {
        throw new Error(`unexpected stopped_by: ${data.stopped_by}`);
      }
      if (typeof data.speech_detected !== 'boolean') {
        throw new Error(`speech_detected must be a boolean, got ${JSON.stringify(data.speech_detected)}`);
      }
      const stat = fs.statSync(data.path);
      // 32 bytes per millisecond at 16kHz 16-bit mono; payloads are whole
      // chunks (or the trimmed ceiling), so the relation is exact.
      const expectedSize = 44 + data.duration_ms * 32;
      if (stat.size !== expectedSize) {
        throw new Error(`size must be exactly 44 + duration_ms*32 = ${expectedSize}, got ${stat.size}`);
      }
      if (data.size_bytes !== stat.size) {
        throw new Error(`size_bytes ${data.size_bytes} != file size ${stat.size}`);
      }
      const header = Buffer.alloc(44);
      const fd = fs.openSync(data.path, 'r');
      fs.readSync(fd, header, 0, 44, 0);
      fs.closeSync(fd);
      if (header.readUInt16LE(22) !== 1) throw new Error('header channels != 1');
      if (header.readUInt32LE(24) !== 16000) throw new Error('header sample rate != 16000');
      if (header.readUInt16LE(34) !== 16) throw new Error('header bit depth != 16');
      if (header.readUInt32LE(40) !== stat.size - 44) {
        throw new Error(`header data size ${header.readUInt32LE(40)} != payload ${stat.size - 44}`);
      }
      try { fs.unlinkSync(data.path); } catch {}
      if (data.stopped_by === 'no_speech_timeout') {
        if (data.speech_detected !== false) throw new Error('no-speech stop must report speech_detected: false');
        if (data.duration_ms !== 10000 || stat.size !== 320044) {
          throw new Error(`no-speech stop must be byte-exact at 10000ms/320044, got ${data.duration_ms}ms/${stat.size}`);
        }
      }
      log('pass', `silence-stopped capture live (${data.stopped_by}, ${stat.size} bytes, speech: ${data.speech_detected})`);
      passed++;
    } catch (err) {
      log('fail', `silence-stopped capture live: ${err.message}`);
      failed++;
    }
  } else {
    log('skip', 'silence-stopped capture live (no default device)');
    skipped++;
  }

  // Test 5: every device carries a string id. The id is the only reliable
  // selector: indexes are positional and names are not unique (real machines
  // report two devices both called "Microphone"). The id may be empty when
  // the host cannot produce one, which is permitted upstream, so this checks
  // the type rather than the content. The by-id capture test skips on an
  // empty id.
  if (hasDevices) {
    try {
      for (const d of deviceList) {
        if (typeof d.id !== 'string') {
          throw new Error(`Device "${d.name}" (index ${d.index}) has id ${JSON.stringify(d.id)}`);
        }
      }
      log('pass', `every device has a string id (${deviceList.length} checked)`);
      passed++;
    } catch (err) {
      log('fail', `device ids: ${err.message}`);
      failed++;
    }
  } else {
    log('skip', 'device ids (no microphone available)');
    skipped++;
  }

  // Tests 6 and 7: capture_audio addresses the same device by index and by
  // stable id, and both deliver the exact requested duration. Prefers the
  // default device; falls back to any device with a non-empty id, since
  // decibri documents id as empty when the host cannot produce one and such
  // a device is selectable only by index.
  if (hasDevices) {
    const target =
      deviceList.find((d) => d.isDefault && d.id) ||
      deviceList.find((d) => d.id) ||
      deviceList[0];

    try {
      // Guard the selector type before sending: JSON.stringify drops
      // undefined-valued properties, so a missing index would silently
      // capture the default device and false-pass this test.
      if (typeof target.index !== 'number') {
        throw new Error(`Device has no numeric index: ${JSON.stringify(target)}`);
      }
      const size = await captureExact(server, { device: target.index });
      log('pass', `capture_audio by index ${target.index} is byte-exact (${size} bytes)`);
      passed++;
    } catch (err) {
      log('fail', `capture_audio by index: ${err.message}`);
      failed++;
    }

    if (typeof target.id === 'string' && target.id.length > 0) {
      try {
        const size = await captureExact(server, { device: target.id });
        log('pass', `capture_audio by id is byte-exact (${size} bytes)`);
        passed++;
      } catch (err) {
        log('fail', `capture_audio by id: ${err.message}`);
        failed++;
      }
    } else {
      log('skip', 'capture_audio by id (no device with a stable id)');
      skipped++;
    }
  } else {
    log('skip', 'capture_audio by index (no microphone available)');
    log('skip', 'capture_audio by id (no microphone available)');
    skipped += 2;
  }

  // Test 8: capture_audio rejects invalid device
  try {
    const res = await server.send('tools/call', {
      name: 'capture_audio',
      arguments: { device: 99999 }
    });
    if (!res.result.isError) throw new Error('Expected isError: true for invalid device');
    log('pass', 'capture_audio rejects invalid device');
    passed++;
  } catch (err) {
    log('fail', `capture_audio invalid device: ${err.message}`);
    failed++;
  }

  // Test 9: Unknown tool returns error
  try {
    const res = await server.send('tools/call', {
      name: 'nonexistent_tool',
      arguments: {}
    });
    if (!res.result.isError) throw new Error('Expected isError: true for unknown tool');
    log('pass', 'Unknown tool returns error');
    passed++;
  } catch (err) {
    log('fail', `Unknown tool: ${err.message}`);
    failed++;
  }

  // Test 10: on a target decibri publishes no binary for, startup fails with
  // an actionable message, not the native loader's advice to delete the
  // lockfile and reinstall. Faking platform/arch in a child process walks
  // the loader's real darwin-x64 path: every load candidate is
  // MODULE_NOT_FOUND, exactly as on an Intel Mac.
  try {
    const probe = spawnSync(process.execPath, ['-e',
      "Object.defineProperty(process, 'platform', { value: 'darwin' });" +
      "Object.defineProperty(process, 'arch', { value: 'x64' });" +
      `require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'audio.js'))});`
    ], { encoding: 'utf8' });
    if (probe.status === 0) throw new Error('Expected load failure on simulated darwin-x64');
    if (!probe.stderr.includes('Intel Mac is not supported')) {
      throw new Error(`Startup error lacks the platform explanation. stderr: ${probe.stderr.slice(0, 200)}`);
    }
    if (!probe.stderr.includes('Supported platforms:')) {
      throw new Error('Startup error lacks the supported-platform list');
    }
    log('pass', 'unsupported platform fails at startup with actionable error');
    passed++;
  } catch (err) {
    log('fail', `unsupported platform error: ${err.message}`);
    failed++;
  }

  // Test 11: when the only device on the machine is the ALSA null device
  // (headless Linux), a default-path capture is refused rather than
  // recording a WAV of pure silence. Explicit selection of the null device
  // stays allowed and is covered by tests 6 and 7 on such machines.
  if (hasDevices && deviceList.every((d) => d.id === 'alsa:null')) {
    try {
      const res = await server.send('tools/call', {
        name: 'capture_audio',
        arguments: { duration_ms: 500 }
      });
      if (!res.result.isError) {
        throw new Error(`Expected refusal, got success: ${res.result.content[0].text}`);
      }
      const text = res.result.content[0].text;
      if (!text.includes('no usable default input device')) {
        throw new Error(`Expected the actionable no-default error, got: ${text}`);
      }
      if (/\.wav/i.test(text)) throw new Error(`Refusal must not produce a WAV: ${text}`);
      log('pass', 'default capture refused when only device is the ALSA null device');
      passed++;
    } catch (err) {
      log('fail', `null-device refusal: ${err.message}`);
      failed++;
    }
  } else if (hasDevices) {
    log('skip', 'null-device refusal (machine has real input devices)');
    skipped++;
  } else {
    log('skip', 'null-device refusal (no microphone available)');
    skipped++;
  }

  // Tests 12-15: deterministic simulations of the guarded machine states,
  // valid on every platform: no flagged default failing via the error
  // event and via a constructor throw (both must translate), the null-only
  // machine (refused on the default path, still selectable explicitly),
  // and a mid-capture failure after audio arrived (must NOT be
  // translated). See test/stub-device-states.js.
  for (const mode of ['no-default', 'no-default-throw', 'null-only', 'mid-capture']) {
    try {
      const sim = spawnSync(process.execPath,
        [path.join(__dirname, 'stub-device-states.js'), mode],
        { encoding: 'utf8' });
      if (sim.status !== 0) {
        throw new Error(`simulation exited ${sim.status}: ${(sim.stderr || sim.stdout || '').trim().slice(0, 300)}`);
      }
      log('pass', `simulated ${mode} state handled as specified`);
      passed++;
    } catch (err) {
      log('fail', `simulated ${mode} state: ${err.message}`);
      failed++;
    }
  }

  // Tests 16-19: argument validation. The SDK checks only that arguments
  // is a record, so the schema's types and ranges bind in lib/validate.js,
  // before the audio layer or the filesystem is reached. Each wire batch
  // asserts the rejection is actionable (names the parameter, shows what
  // was received) and that no WAV appeared in the temp directory: several
  // of these inputs used to reach the capture path (a numeric string
  // recorded for real; a non-numeric string opened the microphone and
  // stalled), so the absence of a file is the regression being pinned.
  const tmpWavs = () =>
    fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('mcp-listen-') && f.endsWith('.wav'));

  // Test 16: capture_audio rejects malformed duration_ms
  try {
    const before = tmpWavs();
    const cases = [
      { args: { duration_ms: '500' }, expect: 'duration_ms must be a number' },
      { args: { duration_ms: 'abc' }, expect: 'duration_ms must be a number' },
      { args: { duration_ms: 500.5 }, expect: 'duration_ms must be an integer' },
      { args: { duration_ms: 50 }, expect: 'duration_ms must be between 100 and 30000' },
      { args: { duration_ms: 50000 }, expect: 'duration_ms must be between 100 and 30000' },
      { args: { duration_ms: true }, expect: 'duration_ms must be a number' },
      { args: { duration_ms: {} }, expect: 'duration_ms must be a number' },
      { args: { duration_ms: [500] }, expect: 'duration_ms must be a number' }
    ];
    for (const c of cases) {
      const res = await server.send('tools/call', { name: 'capture_audio', arguments: c.args });
      if (!res.result || !res.result.isError) {
        throw new Error(`expected isError for duration_ms=${JSON.stringify(c.args.duration_ms)}`);
      }
      const text = res.result.content[0].text;
      if (!text.includes(c.expect)) {
        throw new Error(`expected "${c.expect}" for ${JSON.stringify(c.args.duration_ms)}, got: ${text}`);
      }
    }
    const after = tmpWavs();
    if (after.length > before.length) {
      throw new Error(`rejected calls wrote to disk: ${after.filter((f) => !before.includes(f))}`);
    }
    log('pass', `capture_audio rejects malformed duration_ms (${cases.length} cases, nothing written)`);
    passed++;
  } catch (err) {
    log('fail', `malformed duration_ms: ${err.message}`);
    failed++;
  }

  // Test 17: capture_audio rejects malformed device
  try {
    const before = tmpWavs();
    const cases = [
      { device: true, expect: 'device must be a number (device index) or a string (device id)' },
      { device: {}, expect: 'device must be a number (device index) or a string (device id)' },
      { device: [1], expect: 'device must be a number (device index) or a string (device id)' },
      { device: '', expect: 'device id must be a non-empty string' },
      { device: 1.5, expect: 'device index must be a non-negative integer' },
      { device: -1, expect: 'device index must be a non-negative integer' }
    ];
    for (const c of cases) {
      const res = await server.send('tools/call', {
        name: 'capture_audio',
        arguments: { duration_ms: 500, device: c.device }
      });
      if (!res.result || !res.result.isError) {
        throw new Error(`expected isError for device=${JSON.stringify(c.device)}`);
      }
      const text = res.result.content[0].text;
      if (!text.includes(c.expect)) {
        throw new Error(`expected "${c.expect}" for ${JSON.stringify(c.device)}, got: ${text}`);
      }
      if (!text.includes('list_audio_devices')) {
        throw new Error(`device error must point at list_audio_devices: ${text}`);
      }
    }
    const after = tmpWavs();
    if (after.length > before.length) {
      throw new Error(`rejected calls wrote to disk: ${after.filter((f) => !before.includes(f))}`);
    }
    log('pass', `capture_audio rejects malformed device (${cases.length} cases, nothing written)`);
    passed++;
  } catch (err) {
    log('fail', `malformed device: ${err.message}`);
    failed++;
  }

  // capture_audio rejects malformed stop_on_silence and silence_ms before
  // anything is opened or written, with the same actionable-message
  // contract as every other argument. The cross-field cases matter most: a
  // silence_ms that cannot take effect is rejected, not silently ignored,
  // for the same reason unknown keys are.
  try {
    const before = tmpWavs();
    const cases = [
      { args: { stop_on_silence: 'yes' }, expect: 'stop_on_silence must be a boolean' },
      { args: { stop_on_silence: 1 }, expect: 'stop_on_silence must be a boolean' },
      { args: { stop_on_silence: {} }, expect: 'stop_on_silence must be a boolean' },
      { args: { stop_on_silence: true, silence_ms: '500' }, expect: 'silence_ms must be a number' },
      { args: { stop_on_silence: true, silence_ms: 500.5 }, expect: 'silence_ms must be an integer' },
      { args: { stop_on_silence: true, silence_ms: 50 }, expect: 'silence_ms must be between 100 and 10000' },
      { args: { stop_on_silence: true, silence_ms: 20000 }, expect: 'silence_ms must be between 100 and 10000' },
      { args: { silence_ms: 500 }, expect: 'silence_ms requires stop_on_silence: true' },
      { args: { stop_on_silence: false, silence_ms: 500 }, expect: 'silence_ms requires stop_on_silence: true' }
    ];
    for (const c of cases) {
      const res = await server.send('tools/call', { name: 'capture_audio', arguments: c.args });
      if (!res.result || !res.result.isError) {
        throw new Error(`expected isError for ${JSON.stringify(c.args)}`);
      }
      const text = res.result.content[0].text;
      if (!text.includes(c.expect)) {
        throw new Error(`expected "${c.expect}" for ${JSON.stringify(c.args)}, got: ${text}`);
      }
    }
    const after = tmpWavs();
    if (after.length > before.length) {
      throw new Error(`rejected calls wrote to disk: ${after.filter((f) => !before.includes(f))}`);
    }
    log('pass', `capture_audio rejects malformed stop_on_silence/silence_ms (${cases.length} cases, nothing written)`);
    passed++;
  } catch (err) {
    log('fail', `malformed stop_on_silence/silence_ms: ${err.message}`);
    failed++;
  }

  // Test 18: voice_query validates every argument before capture starts.
  // These messages can only come from the validator: the old path either
  // recorded first or surfaced a transcribe/LLM error, never a type error
  // naming the parameter.
  try {
    const before = tmpWavs();
    const cases = [
      { args: { whisper_model: 5 }, expect: 'whisper_model must be a string' },
      { args: { language: 3 }, expect: 'language must be a string' },
      { args: { model: {} }, expect: 'model must be a string' },
      { args: { prompt: false }, expect: 'prompt must be a string' },
      { args: { duration_ms: '5000' }, expect: 'duration_ms must be a number' },
      { args: { device: {} }, expect: 'device must be a number (device index) or a string (device id)' },
      { args: { stop_on_silence: 'yes' }, expect: 'stop_on_silence must be a boolean' },
      // voice_query stops on silence by default, so a bare silence_ms is
      // valid there; only the explicit opt-out makes it a dead knob.
      { args: { stop_on_silence: false, silence_ms: 500 }, expect: 'silence_ms has no effect when stop_on_silence is false' },
      { args: { silence_ms: 99 }, expect: 'silence_ms must be between 100 and 10000' }
    ];
    for (const c of cases) {
      const res = await server.send('tools/call', { name: 'voice_query', arguments: c.args });
      if (!res.result || !res.result.isError) {
        throw new Error(`expected isError for ${JSON.stringify(c.args)}`);
      }
      const text = res.result.content[0].text;
      if (!text.includes(c.expect)) {
        throw new Error(`expected "${c.expect}" for ${JSON.stringify(c.args)}, got: ${text}`);
      }
    }
    const after = tmpWavs();
    if (after.length > before.length) {
      throw new Error(`rejected calls wrote to disk: ${after.filter((f) => !before.includes(f))}`);
    }
    log('pass', `voice_query rejects malformed arguments (${cases.length} cases, nothing written)`);
    passed++;
  } catch (err) {
    log('fail', `voice_query validation: ${err.message}`);
    failed++;
  }

  // Test 19: unknown arguments are rejected on every tool. The schemas
  // declare additionalProperties: false; the SDK does not enforce it, so
  // without this an unknown argument is silently ignored, and a caller
  // sending output_path is left believing it was honoured.
  try {
    const cases = [
      { name: 'list_audio_devices', args: { foo: 1 }, key: 'foo', accepted: 'none' },
      { name: 'capture_audio', args: { output_path: 'x.wav' }, key: 'output_path', accepted: 'duration_ms, device, stop_on_silence, silence_ms' },
      { name: 'voice_query', args: { extra: true }, key: 'extra', accepted: 'duration_ms, device, stop_on_silence, silence_ms, whisper_model, language, model, prompt' }
    ];
    for (const c of cases) {
      const res = await server.send('tools/call', { name: c.name, arguments: c.args });
      if (!res.result || !res.result.isError) {
        throw new Error(`expected isError for ${c.name} with ${c.key}`);
      }
      const text = res.result.content[0].text;
      if (!text.includes(`unknown argument "${c.key}" for ${c.name}`)) {
        throw new Error(`error must name the argument and tool, got: ${text}`);
      }
      if (!text.includes(`Accepted arguments: ${c.accepted}`)) {
        throw new Error(`error must list accepted arguments, got: ${text}`);
      }
    }
    log('pass', 'unknown arguments rejected on all 3 tools');
    passed++;
  } catch (err) {
    log('fail', `unknown arguments: ${err.message}`);
    failed++;
  }

  // Test 20: values JSON-RPC cannot carry (NaN, Infinity, undefined) are
  // exercised against the validators directly. This is the only layer that
  // can see them: they arise from in-process callers, not the wire.
  try {
    const { validateCaptureArgs, validateVoiceQueryArgs } = require('../lib/validate');
    const expectError = (result, needle, label) => {
      if (!result.error) throw new Error(`${label}: expected rejection`);
      const text = result.error.content[0].text;
      if (!text.includes(needle)) throw new Error(`${label}: expected "${needle}", got: ${text}`);
    };

    expectError(validateCaptureArgs({ duration_ms: NaN }), 'duration_ms must be a finite number', 'NaN duration');
    expectError(validateCaptureArgs({ duration_ms: Infinity }), 'duration_ms must be a finite number', 'Infinity duration');
    expectError(validateCaptureArgs({ duration_ms: -Infinity }), 'duration_ms must be a finite number', '-Infinity duration');
    expectError(validateCaptureArgs({ device: NaN }), 'device index must be a non-negative integer', 'NaN device');
    expectError(validateCaptureArgs({ device: Infinity }), 'device index must be a non-negative integer', 'Infinity device');
    expectError(validateVoiceQueryArgs({ whisper_model: NaN }), 'whisper_model must be a string', 'NaN whisper_model');
    expectError(validateCaptureArgs({ stop_on_silence: true, silence_ms: NaN }), 'silence_ms must be a finite number', 'NaN silence_ms');
    expectError(validateCaptureArgs({ stop_on_silence: true, silence_ms: Infinity }), 'silence_ms must be a finite number', 'Infinity silence_ms');

    // Valid silence-mode arguments pass through unchanged, and a bare
    // silence_ms is legal for voice_query (silence-stopped is its default)
    // while illegal for capture_audio (checked over the wire above).
    const silenceValid = validateCaptureArgs({ duration_ms: 500, stop_on_silence: true, silence_ms: 800 });
    if (silenceValid.error || silenceValid.stopOnSilence !== true || silenceValid.silenceMs !== 800) {
      throw new Error('valid silence-mode arguments must pass through unchanged');
    }
    const vqSilence = validateVoiceQueryArgs({ silence_ms: 800 });
    if (vqSilence.error || vqSilence.silenceMs !== 800 || vqSilence.stopOnSilence !== undefined) {
      throw new Error('voice_query must accept silence_ms without stop_on_silence');
    }

    // Absent means the documented default: null and undefined normalize
    // identically, and valid values pass through unchanged.
    const defaults = validateCaptureArgs({ duration_ms: null, device: null });
    if (defaults.error) throw new Error(`null must select defaults, got: ${defaults.error.content[0].text}`);
    if (defaults.durationMs !== undefined || defaults.device !== undefined) {
      throw new Error('null must normalize to undefined for the default path');
    }
    const valid = validateCaptureArgs({ duration_ms: 500, device: 0 });
    if (valid.error || valid.durationMs !== 500 || valid.device !== 0) {
      throw new Error('valid arguments must pass through unchanged');
    }
    log('pass', 'validators reject NaN/Infinity and normalize null to defaults');
    passed++;
  } catch (err) {
    log('fail', `validator unit checks: ${err.message}`);
    failed++;
  }

  server.kill();

  // Deterministic child-process suites, valid on every platform with no
  // whisper model, no Ollama, and no microphone: the optional-dependency
  // load failures (not-installed vs installed-but-broken must produce
  // different, actionable messages), the startup temp-file sweep (removes
  // only stale recordings this tool created), the packed manifest (the
  // published package carries no test script, so npm test in an installed
  // copy cannot fail on a module that was never shipped), and the
  // silence-stopped capture timelines (the entire stop state machine
  // against scripted VAD scores, byte-exact; the only coverage of that
  // logic that exists on a machine with no microphone, which includes
  // every CI runner); and the voice_query no-answer contract (the five-way
  // decomposition and the filler-detection fix, proving a filler-only
  // transcription never reaches the LLM).
  for (const script of ['stub-loader-errors.js', 'temp-sweep.js', 'packed-manifest.js', 'stub-vad-timeline.js', 'stub-voicequery-contract.js']) {
    try {
      const suite = spawnSync(process.execPath, [path.join(__dirname, script)],
        { encoding: 'utf8', timeout: 240000 });
      if (suite.status !== 0) {
        throw new Error(`exited ${suite.status}: ${(suite.stderr || suite.stdout || '').trim().slice(0, 300)}`);
      }
      log('pass', `${script.replace('.js', '')} suite`);
      passed++;
    } catch (err) {
      log('fail', `${script.replace('.js', '')} suite: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
