import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { nativeCommand } from '../lib/platform.js';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try {
  const { file, args } = nativeCommand(rootDir, process.argv[2]);
  const result = spawnSync(file, args, { cwd: rootDir, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`Native task failed: ${error.message}`);
  process.exitCode = 1;
}
