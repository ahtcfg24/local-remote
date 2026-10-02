import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { platformInfo } from '../lib/platform.js';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try {
  const windows = platformInfo().id === 'win32';
  const action = process.argv[2] || 'start';
  if (!['start', 'guide', 'stop', 'restart', 'status', 'logs', 'doctor', 'uninstall'].includes(action)) throw new Error(`Unsupported service action: ${action}`);
  const file = windows ? 'powershell.exe' : '/bin/bash';
  const args = windows
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(rootDir, 'start.ps1'), action === 'guide' ? 'doctor' : action]
    : [path.join(rootDir, 'remote.sh'), action];
  const result = spawnSync(file, args, { cwd: rootDir, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`Service task failed: ${error.message}`);
  process.exitCode = 1;
}
