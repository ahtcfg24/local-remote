import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAccessToken, generateAccessToken, isSameHostOrigin, tokensMatch } from '../lib/security.js';

test('generateAccessToken creates a 256-bit hexadecimal secret', () => {
  const first = generateAccessToken();
  const second = generateAccessToken();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
});

test('Bearer authorization takes precedence over query token', () => {
  assert.equal(extractAccessToken('/?token=query', 'Bearer header'), 'header');
  assert.equal(extractAccessToken('/?token=query'), 'query');
});

test('tokensMatch rejects missing or partial tokens', () => {
  assert.equal(tokensMatch('secret', 'secret'), true);
  assert.equal(tokensMatch('secre', 'secret'), false);
  assert.equal(tokensMatch('', 'secret'), false);
});

test('isSameHostOrigin accepts same host and rejects cross-site origins', () => {
  assert.equal(isSameHostOrigin('http://192.168.1.8:8787', '192.168.1.8:8787'), true);
  assert.equal(isSameHostOrigin('https://example.com', '192.168.1.8:8787'), false);
  assert.equal(isSameHostOrigin('not a url', '192.168.1.8:8787'), false);
  assert.equal(isSameHostOrigin(undefined, '192.168.1.8:8787'), true);
});

test('empty secrets and opaque or non-web origins never authenticate', () => {
  assert.equal(tokensMatch('', ''), false);
  for (const origin of ['null', 'ftp://localhost:8787', 'http://user@localhost:8787', 'http://localhost:8787/other']) {
    assert.equal(isSameHostOrigin(origin, 'localhost:8787'), false);
  }
});

test('persisted token creation is private, stable and does not overwrite a corrupt secret', async (t) => {
  const { mkdtemp, readFile, writeFile, stat, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadAccessToken } = await import('../lib/security.js');
  const root = await mkdtemp(join(tmpdir(), 'local-remote-token-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'private', 'token');
  const first = await loadAccessToken(file);
  assert.equal(await loadAccessToken(file), first);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, 'private'))).mode & 0o777, 0o700);
  await writeFile(file, 'invalid-secret');
  await assert.rejects(loadAccessToken(file), /invalid/);
  assert.equal(await readFile(file, 'utf8'), 'invalid-secret');
  assert.equal(await loadAccessToken(file, 'configured-secret'), 'configured-secret');
  for (const invalid of [' secret ', 'a\tb', '中文', 'a\nb']) await assert.rejects(loadAccessToken(file, invalid), /ASCII/);
});
