import crypto from 'node:crypto';

export function generateAccessToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function extractAccessToken(rawUrl, authorization = '') {
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (match) return match[1].trim();
  try {
    return new URL(rawUrl || '/', 'http://localhost').searchParams.get('token') || '';
  } catch {
    return '';
  }
}

export function tokensMatch(provided, expected) {
  const actualBuffer = Buffer.from(String(provided || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function isSameHostOrigin(origin, host) {
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === String(host || '').toLowerCase();
  } catch {
    return false;
  }
}
