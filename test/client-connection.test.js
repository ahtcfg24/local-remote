import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteConnection, accessTokenFrom } from '../public/connection.js';
import { TextSender } from '../public/text-sender.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function browserHarness(t, fetchFn) {
  const saved = new Map();
  const sockets = [];
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
    }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    send(message) { this.sent.push(JSON.parse(message)); }
    message(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  for (const [key, value] of Object.entries({
    WebSocket: FakeSocket, fetch: fetchFn, navigator: { onLine: true },
    document: { visibilityState: 'visible' }, location: { protocol: 'http:', host: 'mac.local:8787' },
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const states = [], statuses = [], frames = [], errors = [], results = [];
  const connection = new RemoteConnection({
    token: 'valid-token',
    onState: (...args) => states.push(args), onStatus: (value) => statuses.push(value),
    onFrame: (value) => frames.push(value), onError: (value) => errors.push(value),
    onInputResult: (value) => results.push(value), onReset() {},
  });
  t.after(() => {
    connection.stop();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { connection, sockets, states, statuses, frames, errors, results };
}

const success = (value = {}) => ({ ok: true, status: 200, json: async () => value });

test('pairing accepts fragment, legacy query and bare credentials without accepting a keyless URL', () => {
  assert.equal(accessTokenFrom('http://mac.local/#token=fragment'), 'fragment');
  assert.equal(accessTokenFrom('http://mac.local/?token=legacy'), 'legacy');
  assert.equal(accessTokenFrom('http://mac.local/?token=old#token=new'), 'new');
  assert.equal(accessTokenFrom('  bare-token  '), 'bare-token');
  assert.equal(accessTokenFrom('http://mac.local/'), '');
  assert.equal(accessTokenFrom('bad token'), '');
});

test('unauthorized pairing stops retrying until a credential is replaced', async (t) => {
  let calls = 0;
  const h = browserHarness(t, async (_url, options) => {
    calls += 1;
    return options.headers.Authorization === 'Bearer replacement'
      ? success() : { ok: false, status: 401 };
  });
  await h.connection.connect();
  assert.equal(h.states.at(-1)[0], 'auth');
  assert.equal(h.sockets.length, 0);
  await h.connection.reconnect();
  assert.equal(calls, 1, 'invalid credentials must not enter a retry loop');
  await h.connection.reconnect('replacement');
  assert.equal(h.sockets.length, 1);
  h.sockets[0].open();
  assert.equal(h.states.at(-1)[0], 'open');
});

test('a late preflight cannot replace a newer authenticated connection', async (t) => {
  const oldResponse = deferred();
  let calls = 0;
  const h = browserHarness(t, () => ++calls === 1 ? oldResponse.promise : Promise.resolve(success({ version: 'new' })));
  const oldConnect = h.connection.connect();
  await h.connection.reconnect('replacement');
  oldResponse.resolve(success({ version: 'old' }));
  await oldConnect;
  assert.equal(h.sockets.length, 1);
  assert.match(h.sockets[0].url, /token=replacement$/);
  assert.deepEqual(h.statuses, [{ version: 'new' }]);
});

test('stale socket frames and closes cannot affect a replacement session', async (t) => {
  const h = browserHarness(t, async () => success());
  await h.connection.connect();
  const old = h.sockets[0];
  old.open();
  await h.connection.reconnect();
  const current = h.sockets[1];
  current.open();
  old.message(new Uint8Array([1]).buffer);
  old.message(JSON.stringify({ type: 'status', stale: true }));
  old.close();
  current.message(new Uint8Array([2]).buffer);
  current.message(JSON.stringify({ type: 'input_result', requestId: 'text-1', accepted: true }));
  assert.equal(h.connection.socket, current);
  assert.equal(h.states.at(-1)[0], 'open');
  assert.equal(h.frames.length, 1);
  assert.equal(new Uint8Array(h.frames[0])[0], 2);
  assert.equal(h.statuses.some((value) => value.stale), false);
  assert.deepEqual(h.results, [{ type: 'input_result', requestId: 'text-1', accepted: true }]);
});

test('text is one Unicode-preserving message and remains pending until its own ACK', async () => {
  const sent = [];
  const sender = new TextSender({ send: (payload) => { sent.push(payload); return true; } });
  const result = sender.send('中文😀');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '中文😀');
  sender.settle({ type: 'input_result', requestId: 'unrelated', accepted: true });
  assert.equal(sender.pending.size, 1);
  sender.settle({ type: 'input_result', requestId: sent[0].requestId, accepted: true });
  await result;
  assert.equal(sender.pending.size, 0);
});

test('text refusal, timeout and disconnect do not silently replay a possibly applied edit', async () => {
  const sent = [];
  const sender = new TextSender({ timeoutMs: 10, send: (payload) => { sent.push(payload); return true; } });
  const refused = sender.send('第一段');
  sender.settle({ type: 'error', requestId: sent[0].requestId, message: '输入服务繁忙' });
  await assert.rejects(refused, /输入服务繁忙/);
  await assert.rejects(sender.send('第二段'), /发送结果未确认/);
  const disconnected = sender.send('第三段');
  sender.reset();
  await assert.rejects(disconnected, /连接中断.*结果未确认/);
  assert.equal(sent.length, 3);
  assert.equal(sender.pending.size, 0);
});

test('oversized text is rejected in full before transport; no partial chunks escape', async () => {
  const sent = [];
  const sender = new TextSender({ send: (payload) => { sent.push(payload); return true; } });
  await assert.rejects(sender.send('😀'.repeat(2001)), /文字过长/);
  assert.equal(sent.length, 0);
  const boundary = sender.send('😀'.repeat(2000));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text.length, 4000);
  sender.settle({ type: 'input_result', requestId: sent[0].requestId, accepted: true });
  await boundary;
});
