import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createRemoteServer } from '../lib/remote-server.js';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const token = 'isolated-test-secret';
const baseStatus = { type: 'status', width: 1440, height: 900, fps: 15, capturing: true, screenRecording: true, accessibilityTrusted: true };

class FakeAgent extends EventEmitter {
  constructor(status = {}) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.commands = [];
    this.status = { ...baseStatus, ...status };
    let buffer = '';
    this.stdin.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const command = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        this.commands.push(command);
        this.emit('command', command);
        if (command.cmd === 'status') queueMicrotask(() => this.packet(0x4a, JSON.stringify(this.status)));
      }
    });
    this.stdin.on('finish', () => this.kill());
    queueMicrotask(() => { this.emit('spawn'); this.packet(0x4a, JSON.stringify(this.status)); });
  }
  packet(type, value) {
    if (this.closed) return;
    const data = Buffer.from(value);
    const header = Buffer.alloc(5);
    header[0] = type;
    header.writeUInt32BE(data.length, 1);
    this.stdout.write(Buffer.concat([header, data]));
  }
  kill(signal = 'SIGTERM') {
    if (this.closed) return;
    this.closed = true;
    this.stdin.destroy();
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('close', null, signal));
  }
}

async function waitUntil(condition, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await delay(5);
  }
}

async function fixture(t, options = {}) {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'local-remote-test-'));
  const workers = [];
  const remote = createRemoteServer({
    config: { host: '127.0.0.1', port: 0, fps: 15, quality: 0.6, maxWidth: 1920, maxClients: 4 },
    token, rootDir, runDir,
    spawnProcess: () => { const worker = new FakeAgent(options.status); workers.push(worker); return worker; },
    logger: { error() {} }, restartMinMs: 20, restartMaxMs: 50,
    ...options,
  });
  t.after(async () => { await remote.close(); await rm(runDir, { recursive: true, force: true }); });
  await remote.listen();
  const origin = `http://127.0.0.1:${remote.server.address().port}`;
  return { remote, workers, origin, info: () => fetch(`${origin}/api/info`, { headers: { Authorization: `Bearer ${token}` } }) };
}

async function connect(t, origin, options = {}) {
  const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/ws?token=${token}`, options);
  const messages = [];
  ws.on('message', (data, binary) => { messages.push(binary ? Buffer.from(data) : JSON.parse(data.toString())); });
  ws.on('error', () => {});
  t.after(() => ws.terminate());
  await once(ws, 'open');
  return { ws, messages };
}

async function upgradeStatus(origin, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${origin.replace('http:', 'ws:')}${pathname}`, options);
    ws.once('unexpected-response', (_req, response) => { const status = response.statusCode; response.resume(); ws.terminate(); resolve(status); });
    ws.once('open', () => { ws.terminate(); reject(new Error('Unexpected successful upgrade')); });
    ws.on('error', () => {});
  });
}

test('real HTTP/WS endpoints enforce tokens, exact paths and origins with safe JSON errors', async (t) => {
  const { origin, info } = await fixture(t);
  assert.equal((await fetch(`${origin}/health`)).status, 200);
  const anonymous = await fetch(`${origin}/api/info`);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const status = await (await info()).json();
  assert.equal(status.agent.state, 'ready');
  assert.equal(status.capturing, true);
  assert.ok(status.accessUrls.every((url) => !url.includes(token)));
  assert.equal((await fetch(`${origin}/api/permissions/guide`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'http://attacker.invalid', 'Content-Type': 'application/json' }, body: '{"action":"recheck"}',
  })).status, 403);
  const malformed = await fetch(`${origin}/api/permissions/guide`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, '请求格式无效');
  assert.equal(await upgradeStatus(origin, '/ws?token=wrong'), 401);
  assert.equal(await upgradeStatus(origin, `/wrong?token=${token}`), 404);
  assert.equal(await upgradeStatus(origin, `/ws?token=${token}`, { origin: 'http://attacker.invalid' }), 403);
});

test('client limit is enforced and existing viewers see connection-count changes', async (t) => {
  const { origin } = await fixture(t, { config: { host: '127.0.0.1', port: 0, fps: 15, quality: 0.6, maxWidth: 1920, maxClients: 1 } });
  const first = await connect(t, origin);
  await waitUntil(() => first.messages.some((message) => message.connectedClients === 1));
  assert.equal(await upgradeStatus(origin, `/ws?token=${token}`), 503);
  first.ws.terminate();
});

test('one client cannot release another client drag; disconnect cancels queued pointers without cancelling text', async (t) => {
  const { origin, workers } = await fixture(t);
  const first = await connect(t, origin);
  const second = await connect(t, origin);
  const send = (client, message) => client.ws.send(JSON.stringify(message));
  send(second, { type: 'type_text', text: 'another viewer text', requestId: 'other-text' });
  await waitUntil(() => second.messages.some((message) => message.requestId === 'other-text' && message.accepted));
  send(first, { type: 'pointer_down', x: 20, y: 30 });
  await waitUntil(() => workers[0].commands.some((command) => command.cmd === 'down'));
  send(second, { type: 'pointer_up', x: 90, y: 90 });
  send(second, { type: 'click', x: 90, y: 90 });
  await waitUntil(() => second.messages.some((message) => message.code === 'control_busy'));
  assert.equal(workers[0].commands.filter((command) => command.cmd === 'up' || command.cmd === 'click').length, 0);
  send(first, { type: 'pointer_drag', x: 70, y: 80 });
  await waitUntil(() => workers[0].commands.some((command) => command.cmd === 'drag'));
  first.ws.terminate();
  await waitUntil(() => workers[0].commands.some((command) => command.cmd === 'releasePointers'));
  assert.equal(workers[0].commands.some((command) => command.cmd === 'releaseInputs'), false, 'one viewer disconnect must not cancel another viewer text');
  assert.equal(workers[0].commands.some((command) => command.cmd === 'up'), false, 'queued down must be cancelled rather than replayed with a late up');
  send(second, { type: 'click', x: 90, y: 90 });
  await waitUntil(() => workers[0].commands.some((command) => command.cmd === 'click'));
});

test('server heartbeat reaps silent sockets and releases held input', async (t) => {
  const { origin, workers } = await fixture(t, { heartbeatMs: 30 });
  const client = await connect(t, origin, { autoPong: false });
  client.ws.send(JSON.stringify({ type: 'pointer_down', x: 20, y: 30 }));
  await once(client.ws, 'close');
  assert.ok(workers[0].commands.some((command) => command.cmd === 'releasePointers'));
  assert.ok(workers[0].commands.some((command) => command.cmd === 'releaseInputs'));
});

test('invalid input never reaches native process and complete text is accepted or rejected atomically', async (t) => {
  const { origin, workers } = await fixture(t);
  const client = await connect(t, origin);
  client.ws.send('{"type":"wheel","dy":1e999}');
  await waitUntil(() => client.messages.some((message) => message.code === 'invalid_input'));
  assert.equal(workers[0].commands.some((command) => command.cmd === 'wheel'), false);
  const text = '中'.repeat(4000);
  client.ws.send(JSON.stringify({ type: 'type_text', text, requestId: 'paste-1' }));
  await waitUntil(() => client.messages.some((message) => message.type === 'input_result' && message.requestId === 'paste-1' && message.accepted));
  client.ws.send(JSON.stringify({ type: 'type_text', text, requestId: 'paste-2' }));
  await waitUntil(() => client.messages.some((message) => message.code === 'input_overload' && message.requestId === 'paste-2'));
  assert.deepEqual(workers[0].commands.filter((command) => command.cmd === 'text'), [{ cmd: 'text', text }]);
});

test('permission and capture availability gate control while explicit releases remain usable', async (t) => {
  const { origin, workers } = await fixture(t, { status: { accessibilityTrusted: false } });
  const client = await connect(t, origin);
  client.ws.send(JSON.stringify({ type: 'click', x: 10, y: 20 }));
  await waitUntil(() => client.messages.some((message) => message.code === 'permission_required'));
  assert.equal(workers[0].commands.some((command) => command.cmd === 'click'), false);
});

test('native restart clears stale frames/status and recovers the same WebSocket', async (t) => {
  const { origin, workers } = await fixture(t, { restartMinMs: 100 });
  const client = await connect(t, origin);
  workers[0].packet(0x46, 'old-jpeg');
  await waitUntil(() => client.messages.some(Buffer.isBuffer));
  workers[0].kill();
  await waitUntil(() => client.messages.some((message) => message.agent?.state === 'restarting'));
  const restarting = client.messages.find((message) => message.agent?.state === 'restarting');
  assert.equal(restarting.capturing, false);
  assert.equal(restarting.screen.width, 0);
  const late = await connect(t, origin);
  await waitUntil(() => workers.length === 2);
  await waitUntil(() => late.messages.some((message) => message.agent?.state === 'ready'));
  assert.equal(late.messages.some(Buffer.isBuffer), false);
  client.ws.send(JSON.stringify({ type: 'click', x: 1, y: 2 }));
  await waitUntil(() => workers[1].commands.some((command) => command.cmd === 'click'));
});

test('failed actual native spawn schedules restart without falsely reporting capture', async (t) => {
  const { remote } = await fixture(t, { spawnProcess: undefined, agentBin: '/nonexistent/local-remote-agent', restartMinMs: 30 });
  await waitUntil(() => remote.statusPayload().agent.state === 'restarting');
  assert.match(remote.statusPayload().errors.agent, /ENOENT/);
  assert.equal(remote.statusPayload().capturing, false);
  assert.equal(remote.statusPayload().permissions.accessibility, 'unknown');
});

test('malformed native packets force recovery without unbounded buffering or process crash', async (t) => {
  const { workers, remote } = await fixture(t);
  workers[0].stdout.write(Buffer.from([0x46, 0xff, 0xff, 0xff, 0xff]));
  await waitUntil(() => workers.length === 2);
  await waitUntil(() => remote.statusPayload().agent.state === 'ready');
  assert.equal(workers[0].closed, true);
});

test('capture loss releases ownership so recovery does not leave other viewers permanently blocked', async (t) => {
  const { origin, workers, remote } = await fixture(t);
  const client = await connect(t, origin);
  client.ws.send(JSON.stringify({ type: 'pointer_down', x: 10, y: 20 }));
  await waitUntil(() => remote.statusPayload().control.busy);
  workers[0].status.capturing = false;
  workers[0].packet(0x4a, JSON.stringify(workers[0].status));
  await waitUntil(() => !remote.statusPayload().control.busy);
  assert.ok(workers[0].commands.some((command) => command.cmd === 'releasePointers'));
  assert.equal(remote.statusPayload().capturing, false);
});

test('the last viewer disconnect cancels outstanding native text even without a pressed mouse button', async (t) => {
  const { origin, workers } = await fixture(t);
  const client = await connect(t, origin);
  client.ws.send(JSON.stringify({ type: 'type_text', text: 'pending text' }));
  await waitUntil(() => workers[0].commands.some((command) => command.cmd === 'text'));
  client.ws.terminate();
  await waitUntil(() => workers[0].commands.some((command) => command.cmd === 'releaseInputs'));
});
