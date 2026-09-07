import test from 'node:test';
import assert from 'node:assert/strict';
import { parseControlMessage } from '../lib/control.js';
import { AgentPacketDecoder } from '../lib/agent-protocol.js';

const parse = (message) => parseControlMessage(JSON.stringify(message), { width: 1440, height: 900 });

test('controls reject overflow, coerced coordinates and unsupported commands before native conversion', () => {
  for (const x of [Infinity, '10', null, {}, []]) assert.throws(() => parse({ type: 'pointer_move', x, y: 2 }));
  assert.throws(() => parseControlMessage('{"type":"wheel","dy":1e999}'));
  assert.throws(() => parse({ type: 'pointer_down', x: 1, y: 2, button: 'unknown' }));
  assert.throws(() => parse({ type: 'key_press', key: 'unsupported' }));
  assert.throws(() => parse({ type: 'config', fps: 10 }));
  assert.throws(() => parse({ type: 'type_text', text: 'x'.repeat(4001) }));
});

test('coordinates are clamped to the displayed logical screen and counts to integers', () => {
  assert.deepEqual(parse({ type: 'pointer_down', x: -500, y: 9999, count: 2.9, modifiers: ['CMD', 'bad', 'cmd'] }).command, {
    cmd: 'down', x: 0, y: 899, button: 'left', count: 2, modifiers: ['cmd'],
  });
  assert.equal(parse({ type: 'key_press', key: 'backspace', repeat: 1e9 }).command.repeat, 2000);
});

test('surrogate pairs are preserved; oversized text is rejected rather than silently truncated', () => {
  assert.equal(parse({ type: 'type_text', text: '🙂'.repeat(1000) }).command.text.length, 2000);
  assert.throws(() => parse({ type: 'type_text', text: '🙂'.repeat(2001) }));
});

function packet(type, text) {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

test('native packet decoder preserves headers split across reads and multiple coalesced packets', () => {
  const packets = [];
  const decoder = new AgentPacketDecoder((type, data) => packets.push([type, data.toString()]));
  const data = Buffer.concat([packet(0x4a, '{"type":"status"}'), packet(0x46, 'jpeg')]);
  for (let index = 0; index < data.length; index += 3) decoder.push(data.subarray(index, index + 3));
  assert.deepEqual(packets, [[0x4a, '{"type":"status"}'], [0x46, 'jpeg']]);
});

test('native packet decoder rejects oversized or unknown headers without waiting for allocation', () => {
  const oversized = Buffer.from([0x46, 0xff, 0xff, 0xff, 0xff]);
  assert.throws(() => new AgentPacketDecoder(() => {}).push(oversized));
  assert.throws(() => new AgentPacketDecoder(() => {}).push(Buffer.from([0xff, 0, 0, 0, 1])));
  assert.throws(() => new AgentPacketDecoder(() => {}).push(Buffer.from([0x4a, 0, 2, 0, 0])));
});
