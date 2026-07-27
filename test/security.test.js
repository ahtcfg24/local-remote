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
