import path from 'node:path';

export function platformInfo(platform = process.platform) {
  if (platform === 'darwin') return { id: platform, name: 'macOS', permissionGuide: true };
  if (platform === 'win32') return { id: platform, name: 'Windows', permissionGuide: false };
  throw new Error(`Unsupported platform: ${platform}. Local Remote supports macOS and Windows.`);
}

export function nativeAgentPath(rootDir, platform = process.platform) {
  const info = platformInfo(platform);
  return info.id === 'win32'
    ? path.join(rootDir, '.build', 'local-remote-agent.exe')
    : path.join(rootDir, '.build', 'Local Remote Agent.app', 'Contents', 'MacOS', 'local-remote-agent');
}

export function nativeCommand(rootDir, action, platform = process.platform) {
  const info = platformInfo(platform);
  if (action === 'build') {
    return info.id === 'win32'
      ? { file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(rootDir, 'scripts', 'build-native.ps1')] }
      : { file: '/bin/bash', args: [path.join(rootDir, 'scripts', 'build-native.sh')] };
  }
  if (action === 'test') return { file: nativeAgentPath(rootDir, platform), args: ['--self-test'] };
  throw new Error(`Unsupported native action: ${action}`);
}
