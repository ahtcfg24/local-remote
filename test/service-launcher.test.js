import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { checkService, probeUrl } from '../scripts/service-health.mjs';
import { accessUrls } from '../scripts/access-urls.mjs';

test('service probe handles bind-all and IPv6 addresses', () => {
  assert.equal(probeUrl('0.0.0.0', 8787), 'http://127.0.0.1:8787');
  assert.equal(probeUrl('::', 8787), 'http://[::1]:8787');
  assert.equal(probeUrl('::1', 9999), 'http://[::1]:9999');
});

test('access links respect loopback-only binding and encode fragment credentials', () => {
  const interfaces = { en0: [{ family: 'IPv4', internal: false, address: '192.168.1.2' }] };
  assert.deepEqual(accessUrls({ host: '127.0.0.1', port: 9000, token: 'a&b#c', interfaces }), [
    'http://127.0.0.1:9000/#token=a%26b%23c',
  ]);
  assert.equal(accessUrls({ host: '0.0.0.0', port: 9000, token: 't', interfaces }).length, 2);
});

test('access links omit proxy benchmark and tunnel interfaces and prefer LAN hardware', () => {
  const interfaces = {
    utun5: [{ family: 'IPv4', internal: false, address: '10.8.0.2' }],
    bridge100: [{ family: 'IPv4', internal: false, address: '198.18.0.1' }],
    en0: [{ family: 'IPv4', internal: false, address: '192.168.31.67' }],
  };
  assert.deepEqual(accessUrls({ host: '0.0.0.0', port: 8787, token: 't', interfaces }), [
    'http://127.0.0.1:8787/#token=t', 'http://192.168.31.67:8787/#token=t',
  ]);
});

test('readiness requires authenticated service identity and rejects unrelated HTTP success', async (t) => {
  let mode = 'unrelated';
  let authHeader;
  const server = http.createServer((req, res) => {
    if (mode === 'unrelated') return res.end('another app');
    if (req.url === '/health') return res.end('ok');
    authHeader = req.headers.authorization;
    if (mode === 'unauthorized') {
      res.writeHead(401);
      return res.end('Unauthorized');
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ type: 'status', port: server.address().port, screen: { width: 1920 }, permissions: {}, agent: { state: mode === 'agent-down' ? 'restarting' : 'ready' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const config = { host: '127.0.0.1', port: server.address().port, token: 'fixture-secret' };
  assert.equal(await checkService(config), false);
  mode = 'unauthorized';
  assert.equal(await checkService(config), false);
  mode = 'service';
  assert.equal(await checkService(config), true);
  assert.equal(authHeader, 'Bearer fixture-secret');
  mode = 'agent-down';
  assert.equal(await checkService(config), false);
});

function runLauncher(body) {
  const result = spawnSync('bash', ['-c', `source ./start.sh\n${body}`], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim().split('\n');
}

test('default start keeps a healthy installed service running', () => {
  const calls = runLauncher(`
    detect_service_backend() { echo launchd; }
    load_installed_environment() { return 0; }
    launchctl() { return 0; }
    probe_service() { return 0; }
    print_access_urls() { echo links; }
    prepare_runtime() { echo unexpected-build; return 1; }
    start_managed_service
  `);
  assert.ok(calls.some((line) => line.includes('已在运行')));
  assert.equal(calls.at(-1), 'links');
  assert.ok(!calls.includes('unexpected-build'));
});

test('restart builds before stopping and checks the fixed port after stopping', () => {
  const calls = runLauncher(`
    RESTART_REQUESTED=1
    detect_service_backend() { echo launchd; }
    prepare_runtime() { echo prepare; }
    load_installed_environment() { return 0; }
    launchctl() { return 0; }
    stop_service_backend() { echo stop; }
    kill_existing() { echo legacy; }
    check_port_available() { echo port; }
    install_service() { echo install; }
    start_service_backend() { echo start; }
    wait_for_health() { echo health; }
    start_managed_service
  `).filter((line) => !line.startsWith('[start]'));
  assert.deepEqual(calls, ['prepare', 'stop', 'legacy', 'port', 'install', 'start', 'health']);
});

test('port conflict never installs a service on a silently changed port', () => {
  const result = spawnSync('bash', ['-c', `
    source ./start.sh
    RESTART_REQUESTED=1
    detect_service_backend() { echo launchd; }
    prepare_runtime() { :; }
    load_installed_environment() { return 1; }
    legacy_status() { return 1; }
    stop_service_backend() { echo unexpected-stop; }
    kill_existing() { :; }
    check_port_available() { return 1; }
    install_service() { echo unexpected-install; }
    start_managed_service
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.ok(!result.stdout.includes('unexpected-install'));
  assert.ok(!result.stdout.includes('unexpected-stop'));
});

test('launchd is enabled before bootstrap so a disabled installed service can recover', () => {
  const calls = runLauncher(`
    launchctl() { echo "$1"; }
    start_service_backend
  `);
  assert.deepEqual(calls, ['enable', 'bootstrap']);
});
