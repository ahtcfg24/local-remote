const WINDOWS_SHORTCUTS = {
  'command+c': ['control+c', 'Ctrl+C'],
  'command+v': ['control+v', 'Ctrl+V'],
  'command+x': ['control+x', 'Ctrl+X'],
  'command+a': ['control+a', 'Ctrl+A'],
  'command+z': ['control+z', 'Ctrl+Z'],
  'command+s': ['control+s', 'Ctrl+S'],
  'command+space': ['command+space', 'Win+Space'],
  'command+tab': ['option+tab', 'Alt+Tab'],
  'command+`': ['command+e', '资源管理器'],
  'command+shift+3': ['command+shift+s', '截屏'],
  'command+shift+4': ['command+shift+s', '框选'],
  'control+arrowup': ['command+tab', '任务视图'],
};

export function remotePlatform(platform) {
  const windows = platform === 'win32';
  return { windows, name: windows ? 'Windows' : 'Mac', permissionGuide: !windows };
}

export function shortcutForPlatform(shortcut, label, platform) {
  const mapped = platform === 'win32' && WINDOWS_SHORTCUTS[shortcut];
  return mapped ? { shortcut: mapped[0], label: mapped[1] } : { shortcut, label };
}
