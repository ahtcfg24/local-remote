import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export function generateAccessToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function extractAccessToken(rawUrl, authorization = '') {
  const match = /^Bearer\s+(.+)$/i.exec(typeof authorization === 'string' ? authorization.trim() : '');
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
  return expectedBuffer.length > 0 && actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function isSameHostOrigin(origin, host) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash
      && parsed.host.toLowerCase() === String(host || '').toLowerCase();
  } catch {
    return false;
  }
}

// Refuse unreadable or corrupt persisted secrets instead of silently replacing them
// and invalidating every paired browser. O_EXCL keeps simultaneous starts consistent.
export async function loadAccessToken(tokenFile, configuredToken) {
  await fs.mkdir(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(tokenFile), 0o700);
  if (configuredToken !== undefined && configuredToken !== '') {
    if (typeof configuredToken !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(configuredToken)) {
      throw new Error('REMOTE_TOKEN must contain 1-512 printable ASCII characters without whitespace');
    }
    return configuredToken;
  }
  try {
    const token = (await fs.readFile(tokenFile, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('Saved access token is invalid; check .run/token before restarting');
    await fs.chmod(tokenFile, 0o600);
    return token;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const token = generateAccessToken();
  try {
    await fs.writeFile(tokenFile, `${token}\n`, { flag: 'wx', mode: 0o600 });
    return token;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return loadAccessToken(tokenFile);
  }
}
