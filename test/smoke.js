'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
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

// Capture 500ms through the server with the given extra arguments and assert
// the WAV is byte-exact for the tool's fixed output format. Returns the file
// size. Used by the by-index and by-id device selection tests; the main
// capture test (test 4) keeps its own full set of header assertions.
async function captureExact(server, extraArgs) {
  const DURATION_MS = 500;
  const SAMPLE_RATE = 16000;
  const CHANNELS = 1;
  const BIT_DEPTH = 16;
  const WAV_HEADER_BYTES = 44;
  const expectedPcmBytes =
    Math.round((DURATION_MS * SAMPLE_RATE) / 1000) * CHANNELS * (BIT_DEPTH / 8);
  const expectedSize = WAV_HEADER_BYTES + expectedPcmBytes;

  const res = await server.send('tools/call', {
    name: 'capture_audio',
    arguments: { duration_ms: DURATION_MS, ...extraArgs }
  });
  if (res.result.isError) throw new Error(res.result.content[0].text);
  const data = JSON.parse(res.result.content[0].text);
  const stat = fs.statSync(data.path);
  try { fs.unlinkSync(data.path); } catch {}
  if (stat.size !== expectedSize) {
    throw new Error(`Expected exactly ${expectedSize} bytes for ${DURATION_MS}ms, got ${stat.size}`);
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

  function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method}`));
      }, RESPONSE_TIMEOUT);
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

  // Test 2: All 3 tools advertised
  try {
    const res = await server.send('tools/list', {});
    const names = res.result.tools.map(t => t.name).sort();
    const expected = ['capture_audio', 'list_audio_devices', 'voice_query'];
    if (JSON.stringify(names) !== JSON.stringify(expected)) {
      throw new Error(`Expected tools ${expected}, got ${names}`);
    }
    log('pass', 'All 3 tools advertised');
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
        log('pass', 'default capture returns actionable error (no default device)');
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

  server.kill();

  console.log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
