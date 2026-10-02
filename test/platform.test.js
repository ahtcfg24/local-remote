import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { nativeAgentPath, nativeCommand, platformInfo } from '../lib/platform.js';
import { remotePlatform, shortcutForPlatform } from '../public/platform.js';

test('native platform dispatch selects the installed Windows or macOS agent without shell interpolation', () => {
  const root = path.resolve('a folder with spaces');
  assert.equal(nativeAgentPath(root, 'win32'), path.join(root, '.build', 'local-remote-agent.exe'));
  assert.equal(nativeAgentPath(root, 'darwin'), path.join(root, '.build', 'Local Remote Agent.app', 'Contents', 'MacOS', 'local-remote-agent'));
  assert.deepEqual(nativeCommand(root, 'test', 'win32'), { file: nativeAgentPath(root, 'win32'), args: ['--self-test'] });
  const build = nativeCommand(root, 'build', 'win32');
  assert.equal(build.file, 'powershell.exe');
  assert.equal(build.args.at(-1), path.join(root, 'scripts', 'build-native.ps1'));
  assert.equal(nativeCommand(root, 'build', 'darwin').file, '/bin/bash');
  assert.throws(() => platformInfo('linux'), /Unsupported platform/);
  assert.throws(() => nativeCommand(root, 'unsupported', 'win32'), /Unsupported native action/);
});

test('touch shortcuts target Windows Ctrl, Alt and Win keys while preserving macOS shortcuts', () => {
  assert.equal(remotePlatform('win32').permissionGuide, false);
  assert.deepEqual(shortcutForPlatform('command+c', '⌘C', 'win32'), { shortcut: 'control+c', label: 'Ctrl+C' });
  assert.deepEqual(shortcutForPlatform('command+tab', '⌘Tab', 'win32'), { shortcut: 'option+tab', label: 'Alt+Tab' });
  assert.deepEqual(shortcutForPlatform('command+shift+4', '框选', 'win32'), { shortcut: 'command+shift+s', label: '框选' });
  assert.deepEqual(shortcutForPlatform('command+c', '⌘C', 'darwin'), { shortcut: 'command+c', label: '⌘C' });
});
