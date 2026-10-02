// File-based CLI avoids Windows PowerShell 5.1's native -e quote rewriting.
import net from 'node:net';
import { loadConfig } from '../lib/config.js';
import { loadAccessToken } from '../lib/security.js';

const config = loadConfig();
switch (process.argv[2]) {
  case 'config':
    console.log(JSON.stringify(config));
    break;
  case 'token':
    console.log(await loadAccessToken('.run/token', process.env.REMOTE_TOKEN));
    break;
  case 'port': {
    const server = net.createServer();
    server.on('error', (error) => {
      console.error(`[start] Cannot bind ${config.host}:${config.port} (${error.code}); free this fixed port before starting.`);
      process.exitCode = 1;
    });
    server.listen({ host: config.host, port: config.port, exclusive: true }, () => server.close());
    break;
  }
  default:
    console.error('Usage: windows-runtime.mjs config|token|port');
    process.exitCode = 2;
}
