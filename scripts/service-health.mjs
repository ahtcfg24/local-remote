import { pathToFileURL } from 'node:url';

export function probeUrl(host, port) {
  const address = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return `http://${address.includes(':') ? `[${address}]` : address}:${port}`;
}

// A 200 from an unrelated program is not proof that this service started.
// Check the authenticated API too, without putting the credential in a URL.
export async function checkService({ host, port, token, timeoutMs = 1200, onInfo }) {
  try {
    const origin = probeUrl(host, port);
    const signal = AbortSignal.timeout(timeoutMs);
    const health = await fetch(`${origin}/health`, { signal, redirect: 'error' });
    if (!health.ok || (await health.text()).trim() !== 'ok') return false;
    const info = await fetch(`${origin}/api/info`, {
      headers: { authorization: `Bearer ${token}` }, signal, redirect: 'error',
    });
    if (!info.ok) return false;
    const body = await info.json();
    const ready = body.type === 'status' && body.port === Number(port)
      && typeof body.screen?.width === 'number' && typeof body.permissions === 'object'
      // Older installed versions do not include agent state. New versions must
      // have a responding worker; missing TCC grants still count as service-ready.
      && (!body.agent || body.agent.state === 'ready');
    if (ready) onInfo?.(body);
    return ready;
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await checkService({
    host: process.env.HOST || '0.0.0.0', port: process.env.PORT || 8787,
    token: process.env.REMOTE_TOKEN || '',
    onInfo: process.argv.includes('--details') ? (info) => {
      const screen = info.permissions.screenRecording === 'ok';
      const input = info.permissions.accessibility === 'ok';
      console.log(`[start] 录屏${screen ? '已授权' : '待授权'}；辅助功能${input ? '已授权' : '待授权'}；${info.capturing ? '画面采集中' : '尚无画面'}`);
      if (!screen || !input) console.log('[start] 请在 Mac「系统设置 → 隐私与安全性」中为 Local Remote Agent 开启屏幕录制和辅助功能。若开关已开启却仍未授权，请查看 README.zh-CN.md 中的权限重置步骤。');
    } : undefined,
  }) ? 0 : 1;
}
