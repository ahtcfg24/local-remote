// LAN entry point. The HTTP/WebSocket and native-worker lifecycle live in lib/remote-server.js.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';
import { loadConfig } from './lib/config.js';
import { loadAccessToken } from './lib/security.js';
import { createRemoteServer } from './lib/remote-server.js';
import { nativeAgentPath } from './lib/platform.js';
import { watchStopFile } from './lib/stop-watcher.js';
import { accessUrls } from './scripts/access-urls.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const runDir = path.join(rootDir, '.run');
const config = loadConfig();
let remote;
let stopWatching = () => {};


try {
  const agentBin = nativeAgentPath(rootDir);
  await fs.access(agentBin, fs.constants.X_OK);
  const token = await loadAccessToken(path.join(runDir, 'token'), process.env.REMOTE_TOKEN);
  remote = createRemoteServer({ config, token, rootDir, runDir, agentBin });
  await remote.listen();
  if (process.platform === 'win32' && process.env.LOCAL_REMOTE_STOP_FILE) {
    stopWatching = watchStopFile({
      file: process.env.LOCAL_REMOTE_STOP_FILE,
      onStop: shutdown,
      onError: (error) => console.error(`Graceful shutdown failed: ${error.message}`),
    });
  }
  const urls = accessUrls({ ...config, token });
  console.log('\nLocal Remote Control');
  for (const url of urls) console.log(`Access URL: ${url}`);
  console.log('\n手机扫码打开控制台：');
  const qrUrl = urls.find((url) => !['127.0.0.1', '[::1]', 'localhost'].includes(new URL(url).hostname)) || urls[0];
  qrcode.generate(qrUrl, { small: true });
  console.log('Security note: LAN only. Do not expose this port to the public internet.\n');
} catch (error) {
  console.error(`Local Remote failed to start: ${error.message}`);
  if (error.code === 'ENOENT' || error.code === 'EACCES') console.error(`Run "npm run build:native" and "${process.platform === 'win32' ? '.\\start.ps1 doctor' : './start.sh doctor'}" to check the installation.`);
  await remote?.close();
  process.exitCode = 1;
}

async function shutdown() {
  stopWatching();
  await remote?.close();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
