import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.js';

test('loadConfig returns safe defaults', () => {
  assert.deepEqual(loadConfig({}), {
    host: '0.0.0.0',
    port: 8787,
    fps: 15,
    quality: 0.6,
    maxWidth: 1920,
    maxClients: 4,
  });
});

test('loadConfig clamps and normalizes numeric settings', () => {
  const config = loadConfig({ PORT: '70000', FPS: '0', QUALITY: '2', MAX_WIDTH: '1000.9', MAX_CLIENTS: '3.8' });
  assert.deepEqual(config, {
    host: '0.0.0.0',
    port: 65535,
    fps: 1,
    quality: 0.95,
    maxWidth: 1000,
    maxClients: 3,
  });
});

test('loadConfig falls back when values are not numbers', () => {
  const config = loadConfig({ PORT: 'nope', FPS: 'NaN', QUALITY: '' });
  assert.equal(config.port, 8787);
  assert.equal(config.fps, 15);
  assert.equal(config.quality, 0.6);
});
