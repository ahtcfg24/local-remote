import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { watchStopFile } from '../lib/stop-watcher.js';

test('private stop marker triggers one graceful shutdown and stops polling', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'local-remote-stop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'windows-stop');
  let calls = 0;
  let complete;
  const stopped = new Promise((resolve) => { complete = resolve; });
  const dispose = watchStopFile({ file, intervalMs: 10, onStop: async () => { calls++; complete(); } });
  t.after(dispose);
  await delay(25);
  assert.equal(calls, 0);
  await writeFile(file, 'stop\n');
  let timer;
  try {
    await Promise.race([stopped, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Stop marker was not observed')), 2000); })]);
  } finally { clearTimeout(timer); }
  await delay(30);
  assert.equal(calls, 1);
});

test('disposing the marker watcher prevents a later marker from shutting down', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'local-remote-stop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'windows-stop');
  let calls = 0;
  const dispose = watchStopFile({ file, intervalMs: 10, onStop: () => { calls++; } });
  dispose();
  await writeFile(file, 'stop\n');
  await delay(30);
  assert.equal(calls, 0);
});
