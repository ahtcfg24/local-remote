import os from 'node:os';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { probeUrl } from './service-health.mjs';

export function accessUrls({ host, port, token, interfaces = os.networkInterfaces() }) {
  const addresses = new Set([host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host]);
  if (host === '0.0.0.0' || host === '::') {
    const networks = Object.entries(interfaces).sort(([a], [b]) =>
      Number(/^(en|eth|wl)/.test(b)) - Number(/^(en|eth|wl)/.test(a)));
    for (const [name, entries] of networks) {
      if (/^(utun|tun|tap|lo)/.test(name)) continue;
      for (const entry of entries || []) {
        const parts = entry.address.split('.').map(Number);
        const unusable = parts[0] === 0 || parts[0] === 127 || parts[0] >= 224
          || (parts[0] === 169 && parts[1] === 254)
          || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19));
        if (entry.family === 'IPv4' && !entry.internal && net.isIP(entry.address) === 4 && !unusable) addresses.add(entry.address);
      }
    }
  }
  return [...addresses].map((address) => `${probeUrl(address, port)}/#token=${encodeURIComponent(token)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const url of accessUrls({
    host: process.env.HOST || '0.0.0.0', port: process.env.PORT || 8787, token: process.env.REMOTE_TOKEN || '',
  })) console.log(`[start] 控制台: ${url}`);
}
