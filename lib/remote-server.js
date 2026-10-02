import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { extractAccessToken, isSameHostOrigin, tokensMatch } from './security.js';
import { AgentPacketDecoder } from './agent-protocol.js';
import { parseControlMessage, RateBudget } from './control.js';
import { accessUrls } from '../scripts/access-urls.mjs';
import { nativeAgentPath, platformInfo } from './platform.js';

const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const MAX_AGENT_INPUT_BYTES = 256 * 1024;

// The transport/lifecycle can run independently of launchd and native capture. Tests
// exercise actual HTTP and WebSocket connections without injecting input into this Mac.
export function createRemoteServer({
  config, token, rootDir, runDir = path.join(rootDir, '.run'),
  platform = process.platform, agentBin = nativeAgentPath(rootDir, platform),
  agentArgs = [], agentEnv = {}, spawnProcess = spawn, logger = console,
  heartbeatMs = 10000, restartMinMs = 1000, restartMaxMs = 10000, nativeAckTimeoutMs = 10000,
}) {
  if (typeof token !== 'string' || !token) throw new Error('An access token is required');
  const nativePlatform = platformInfo(platform);
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  const clients = new Set();
  const statusWaiters = new Set();
  const pendingText = new Map();
  let commandSequence = 0;
  const inputBudget = new RateBudget(4000, 1000);
  let agent = null;
  let agentAlive = false;
  let agentState = 'starting';
  let lastAgentResponseAt = Date.now();
  let lastAgentStatus = null;
  let lastAgentError = null;
  let lastFrame = null;
  let dragOwner = null;
  let agentRestartTimer = null;
  let agentRestartDelay = restartMinMs;
  let heartbeatTimer = null;
  let statusTimer = null;
  let shuttingDown = false;
  let closePromise = null;
  let statusRefresh = null;
  let permissionWrite = Promise.resolve();

  function statusPayload(extra = {}) {
    const status = lastAgentStatus || {};
    return {
      type: 'status',
      platform: nativePlatform.id,
      platformName: nativePlatform.name,
      capabilities: { permissionGuide: nativePlatform.permissionGuide },
      screen: {
        width: status.width || 0, height: status.height || 0,
        displayID: status.displayID ?? null, displayName: status.displayName || '',
        frameWidth: status.frameWidth || 0, frameHeight: status.frameHeight || 0,
        originX: status.originX || 0, originY: status.originY || 0,
      },
      fps: status.fps || config.fps,
      quality: status.quality ?? config.quality,
      maxWidth: status.maxWidth ?? config.maxWidth,
      capturing: agentAlive && Boolean(status.capturing),
      permissions: {
        screenRecording: !lastAgentStatus ? 'unknown' : status.screenRecording ? 'ok' : 'not_granted',
        accessibility: !lastAgentStatus ? 'unknown' : status.accessibilityTrusted ? 'ok' : 'not_trusted',
      },
      errors: { capture: status.captureError || null, agent: lastAgentError },
      agent: { state: agentState },
      ...(nativePlatform.id === 'win32' ? { session: {
        id: status.sessionID ?? null,
        interactive: Boolean(status.interactiveSession),
        inputDesktop: status.inputDesktop || '',
        inputAvailable: Boolean(status.inputAvailable ?? status.accessibilityTrusted),
      } } : {}),
      control: { busy: Boolean(dragOwner) },
      connectedClients: clients.size,
      maxClients: config.maxClients,
      ...extra,
    };
  }

  function sendJson(ws, payload) {
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < MAX_BUFFERED_BYTES) {
      ws.send(JSON.stringify(payload), (error) => { if (error) ws.terminate(); });
    }
  }

  function broadcastStatus() {
    for (const ws of clients) sendJson(ws, statusPayload({ control: { busy: Boolean(dragOwner), owned: dragOwner === ws } }));
  }

  function controlError(ws, code, message, requestId) {
    // Rejected mousemove floods must not create their own outbound backlog.
    const now = performance.now();
    if (!requestId && ws.lastErrorCode === code && now - ws.lastErrorAt < 1000) return;
    ws.lastErrorAt = now;
    ws.lastErrorCode = code;
    sendJson(ws, { type: 'error', code, message, ...(requestId ? { requestId } : {}) });
  }

  function settlePendingText(id, error = null) {
    const pending = pendingText.get(id);
    if (!pending) return;
    pendingText.delete(id);
    clearTimeout(pending.timer);
    if (error) controlError(pending.ws, 'native_input_failed', error, pending.requestId);
    else sendJson(pending.ws, { type: 'input_result', requestId: pending.requestId, accepted: true });
  }

  function cancelPendingText(message, ws = null) {
    for (const [id, pending] of pendingText) {
      if (!ws || pending.ws === ws) settlePendingText(id, message);
    }
  }

  function sendToAgent(command) {
    if (!agentAlive || !agent?.stdin?.writable || agent.stdin.destroyed) return false;
    if (agent.stdin.writableLength > MAX_AGENT_INPUT_BYTES) return false;
    try {
      agent.stdin.write(`${JSON.stringify(command)}\n`);
      return true; // write(false) means accepted with backpressure, not rejected.
    } catch {
      return false;
    }
  }

  function releaseInputs(ws, notify = true) {
    if (!ws.pressedButtons.size) return;
    ws.pressedButtons.clear();
    if (dragOwner === ws) {
      // Cancel queued pointer events as well as releasing actual held buttons.
      // Global releaseInputs would also truncate another viewer's accepted text.
      if (!sendToAgent({ cmd: 'releasePointers' }) && agentAlive) agent?.kill();
      dragOwner = null;
      if (notify) broadcastStatus();
    }
  }

  function settleStatusWaiters() {
    for (const waiter of statusWaiters) waiter(lastAgentStatus);
    statusWaiters.clear();
  }

  function handleAgentJson(text) {
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error('Invalid native status JSON'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid native status object');
    if (payload.type === 'status') {
      lastAgentStatus = payload;
      lastAgentResponseAt = Date.now();
      lastAgentError = null;
      agentState = 'ready';
      if (!payload.capturing) lastFrame = null;
      if ((!payload.capturing || !payload.accessibilityTrusted) && dragOwner) releaseInputs(dragOwner, false);
      // Serialize writes so an older status cannot replace a newer permission result.
      permissionWrite = permissionWrite.then(() => fs.writeFile(path.join(runDir, 'agent-permissions.json'), `${JSON.stringify({
        screenRecording: Boolean(payload.screenRecording),
        accessibilityTrusted: Boolean(payload.accessibilityTrusted),
        updatedAt: new Date().toISOString(),
      })}\n`, { mode: 0o600 })).catch((error) => logger.error(`[agent] failed to persist permission status: ${error.message}`));
      settleStatusWaiters();
      broadcastStatus();
    } else if (payload.type === 'error') {
      lastAgentError = typeof payload.message === 'string' ? payload.message.slice(0, 2000) : 'Native agent error';
      // A queued down may have failed before reaching the native desktop. Clear
      // its server ownership and cancel only pointer jobs so another viewer's
      // accepted text remains intact.
      if (dragOwner) releaseInputs(dragOwner, false);
      logger.error(`[agent] ${lastAgentError}`);
      for (const ws of clients) controlError(ws, 'agent_error', lastAgentError);
      broadcastStatus();
    } else if (payload.type === 'command_ack' && nativePlatform.id === 'win32' && payload.cmd === 'text') {
      settlePendingText(payload.id, payload.ok === true ? null
        : typeof payload.error === 'string' ? payload.error.slice(0, 2000) : 'Windows 输入服务未完成文本输入');
    }
  }

  function spawnAgent() {
    if (shuttingDown) return;
    agentState = 'starting';
    lastAgentResponseAt = Date.now();
    lastAgentStatus = null;
    lastFrame = null;
    const child = spawnProcess(agentBin, agentArgs, {
      cwd: rootDir,
      env: { ...process.env, ...agentEnv, AGENT_FPS: String(config.fps), AGENT_QUALITY: String(config.quality), AGENT_MAX_WIDTH: String(config.maxWidth) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    agent = child;
    agentAlive = false;
    let spawnError = null;
    let healthyTimer = null;
    const decoder = new AgentPacketDecoder((type, payload) => {
      if (type === 0x4a) handleAgentJson(payload.toString('utf8'));
      else {
        if (!agentAlive || !lastAgentStatus?.capturing) return;
        lastFrame = Buffer.from(payload);
        for (const ws of clients) {
          if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < MAX_BUFFERED_BYTES) {
            ws.send(lastFrame, { binary: true }, (error) => { if (error) ws.terminate(); });
          }
        }
      }
    });
    child.once('spawn', () => {
      if (child !== agent || shuttingDown) return;
      agentAlive = true;
      // Reset backoff only after a stable run, not on a status emitted immediately
      // before a repeated crash.
      healthyTimer = setTimeout(() => { agentRestartDelay = restartMinMs; }, 30000);
      healthyTimer.unref();
      sendToAgent({ cmd: 'status' });
    });
    child.stdout.on('data', (chunk) => {
      if (child !== agent || shuttingDown) return;
      try { decoder.push(chunk); } catch (error) {
        spawnError = error.message;
        lastAgentError = spawnError;
        child.kill();
      }
    });
    child.stderr.on('data', (chunk) => logger.error(`[agent] ${chunk.toString().trim().slice(0, 4000)}`));
    child.stdin.on('error', (error) => {
      if (child !== agent || shuttingDown) return;
      spawnError = `agent input failed: ${error.message}`;
      child.kill();
    });
    child.once('error', (error) => { spawnError = `agent spawn failed: ${error.message}`; });
    // 'close' occurs for both failed spawn and normal exit; 'exit' alone misses ENOENT.
    child.once('close', (code, signal) => {
      clearTimeout(healthyTimer);
      if (child !== agent) return;
      agent = null;
      agentAlive = false;
      agentState = shuttingDown ? 'stopped' : 'restarting';
      lastFrame = null;
      lastAgentStatus = null;
      lastAgentError = spawnError || `agent exited (code=${code}, signal=${signal})`;
      cancelPendingText('Windows 输入服务已重启，发送结果未确认；请检查远程电脑后再重试');
      for (const ws of clients) ws.pressedButtons.clear();
      dragOwner = null;
      settleStatusWaiters();
      if (shuttingDown) return;
      logger.error(`${lastAgentError}; restarting in ${agentRestartDelay}ms`);
      broadcastStatus();
      agentRestartTimer = setTimeout(spawnAgent, agentRestartDelay);
      agentRestartDelay = Math.min(restartMaxMs, agentRestartDelay * 2);
    });
  }

  function refreshAgentStatus(timeoutMs = 800) {
    if (statusRefresh) return statusRefresh;
    statusRefresh = new Promise((resolve) => {
      let timer;
      const waiter = (payload) => { clearTimeout(timer); statusWaiters.delete(waiter); resolve(payload); };
      statusWaiters.add(waiter);
      timer = setTimeout(() => waiter(lastAgentStatus), timeoutMs);
      if (!sendToAgent({ cmd: 'status' })) waiter(lastAgentStatus);
    }).finally(() => { statusRefresh = null; });
    return statusRefresh;
  }

  function handleControlMessage(ws, raw) {
    let parsed;
    let requestId;
    const reject = (code, message) => controlError(ws, code, message, requestId);
    try {
      const envelope = JSON.parse(raw);
      if (envelope?.type === 'type_text' && typeof envelope.requestId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(envelope.requestId)) requestId = envelope.requestId;
      parsed = parseControlMessage(raw, lastAgentStatus || {});
    } catch (error) {
      reject('invalid_input', error instanceof SyntaxError ? '控制消息格式无效' : error.message);
      return;
    }
    if (parsed.type === 'ping') { sendJson(ws, { type: 'pong' }); return; }
    if (parsed.type === 'release_inputs') { releaseInputs(ws); return; }
    const { type, command, cost } = parsed;
    // A release is allowed even when capture or permission status has changed.
    if (type === 'pointer_up') {
      if (!ws.pressedButtons.has(command.button)) return;
      if (!sendToAgent(command)) agent?.kill();
      ws.pressedButtons.delete(command.button);
      if (!ws.pressedButtons.size) { dragOwner = null; broadcastStatus(); }
      return;
    }
    if (dragOwner && dragOwner !== ws) {
      reject('control_busy', '另一台设备正在拖拽，请稍后操作');
      return;
    }
    if (!agentAlive || agentState !== 'ready' || !lastAgentStatus?.capturing) {
      reject('agent_unavailable', '屏幕采集暂不可用，请等待恢复后操作');
      return;
    }
    if (!lastAgentStatus.accessibilityTrusted) {
      reject('permission_required', nativePlatform.id === 'win32'
        ? 'Windows 输入服务不可用，请确认用户已登录且桌面未锁定'
        : '请先在 Mac 上授予 Local Remote Agent 辅助功能权限');
      return;
    }
    if (type === 'pointer_drag' && !ws.pressedButtons.has(command.button)) return;
    if (type === 'pointer_down' && ws.pressedButtons.has(command.button)) return;
    if (type === 'click' && ws.pressedButtons.has(command.button)) {
      reject('invalid_input', '请先结束当前拖拽');
      return;
    }
    const needsNativeAck = nativePlatform.id === 'win32' && type === 'type_text' && requestId;
    const id = needsNativeAck ? `text-${++commandSequence}` : null;
    if (id) {
      const timer = setTimeout(() => settlePendingText(id, 'Windows 输入服务响应超时，发送结果未确认；请检查远程电脑后再重试'), nativeAckTimeoutMs);
      timer.unref();
      pendingText.set(id, { ws, requestId, timer });
    }
    if (!ws.inputBudget.consume() || !inputBudget.consume(cost) || !sendToAgent(id ? { ...command, id } : command)) {
      if (id) { clearTimeout(pendingText.get(id)?.timer); pendingText.delete(id); }
      reject('input_overload', '操作过于密集，请稍后重试');
      return;
    }
    if (type === 'type_text' && requestId && !needsNativeAck) sendJson(ws, { type: 'input_result', requestId, accepted: true });
    if (type === 'pointer_down' || type === 'pointer_drag') {
      ws.pressedButtons.set(command.button, { x: command.x, y: command.y });
      if (!dragOwner) { dragOwner = ws; broadcastStatus(); }
    }
  }

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    });
    next();
  });

  function hasValidToken(rawUrl, authorization = '') {
    return tokensMatch(extractAccessToken(rawUrl, authorization), token);
  }

  app.use('/api', (req, res, next) => {
    if (!isSameHostOrigin(req.get('origin'), req.get('host'))) {
      res.status(403).json({ error: '不允许跨站访问控制接口' });
      return;
    }
    if (!hasValidToken(req.originalUrl || req.url, req.get('authorization'))) {
      res.status(401).json({ error: '访问令牌缺失或已失效，请重新扫描二维码' });
      return;
    }
    next();
  }, express.json({ limit: '20kb' }));

  app.get('/health', (_req, res) => res.type('text/plain').send('ok'));
  app.get(['/api/info', '/api/permissions/status'], async (_req, res) => {
    await refreshAgentStatus();
    const port = server.address()?.port || config.port;
    const urls = accessUrls({ host: config.host, port, token: '' }).map((url) => { const parsed = new URL(url); parsed.hash = ''; return parsed.href; });
    res.json(statusPayload({ host: config.host, port, accessUrls: urls }));
  });

  function launch(file, args, detached = false) {
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, { cwd: rootDir, detached, stdio: 'ignore' });
      child.once('error', reject);
      if (detached) child.once('spawn', () => { child.unref(); resolve(); });
      else child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`open exited with ${code}`)));
    });
  }

  app.post('/api/permissions/guide', async (req, res) => {
    const action = req.body?.action ?? 'open_guide';
    try {
      if (!nativePlatform.permissionGuide && action !== 'recheck' && action !== 'open_guide') {
        res.status(400).json({ error: 'Windows 不支持 macOS 权限操作，请在已登录的桌面会话中运行服务', action });
        return;
      }
      if (!nativePlatform.permissionGuide) {
        await refreshAgentStatus();
        res.json(statusPayload({ action }));
        return;
      }
      if (action === 'open_guide') {
        const bin = path.join(rootDir, '.build', 'permission-guide');
        await fs.access(bin);
        await launch(bin, [path.join(rootDir, '.build', 'Local Remote Agent.app'), rootDir], true);
      } else if (action === 'open_screen_settings' || action === 'open_accessibility_settings') {
        const pane = action === 'open_screen_settings' ? 'Privacy_ScreenCapture' : 'Privacy_Accessibility';
        await launch('/usr/bin/open', [`x-apple.systempreferences:com.apple.preference.security?${pane}`]);
      } else if (action === 'trigger_screen_recording' || action === 'trigger_accessibility_prompt') {
        if (!sendToAgent({ cmd: action === 'trigger_screen_recording' ? 'promptScreen' : 'promptAccessibility' })) {
          res.status(503).json({ error: '原生服务暂不可用，请稍后重试', action });
          return;
        }
      } else if (action !== 'recheck') {
        res.status(400).json({ error: '不支持的权限操作' });
        return;
      }
      await refreshAgentStatus();
      res.json(statusPayload({ action }));
    } catch (error) {
      logger.error(`permission guide failed: ${error.message}`);
      res.status(500).json({ error: '无法打开授权引导，请在 Mac 上检查服务状态', action });
    }
  });

  app.use('/public', express.static(path.join(rootDir, 'public'), { etag: false, maxAge: 0 }));
  app.get('/', (_req, res) => res.sendFile(path.join(rootDir, 'public', 'index.html')));
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use((error, _req, res, _next) => {
    const status = error.status === 413 ? 413 : error.status === 400 ? 400 : 500;
    if (status === 500) logger.error(`HTTP request failed: ${error.message}`);
    res.status(status).json({ error: status === 413 ? '请求内容过大' : status === 400 ? '请求格式无效' : '服务处理失败' });
  });

  function rejectUpgrade(socket, status, reason) {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    let pathname;
    try { pathname = new URL(req.url || '', 'http://localhost').pathname; } catch { pathname = ''; }
    if (pathname !== '/ws') return rejectUpgrade(socket, 404, 'Not Found');
    if (shuttingDown) return rejectUpgrade(socket, 503, 'Service Unavailable');
    if (!isSameHostOrigin(req.headers.origin, req.headers.host)) return rejectUpgrade(socket, 403, 'Forbidden');
    if (!hasValidToken(req.url || '', req.headers.authorization)) return rejectUpgrade(socket, 401, 'Unauthorized');
    if (clients.size >= config.maxClients) return rejectUpgrade(socket, 503, 'Service Unavailable');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.pressedButtons = new Map();
    ws.inputBudget = new RateBudget(240, 120);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) { controlError(ws, 'invalid_input', '控制消息必须使用 JSON 文本'); return; }
      handleControlMessage(ws, data.toString());
    });
    ws.on('close', () => {
      cancelPendingText('连接中断，发送结果未确认', ws);
      releaseInputs(ws, false);
      clients.delete(ws);
      if (!clients.size) sendToAgent({ cmd: 'releaseInputs' });
      broadcastStatus();
    });
    ws.on('error', (error) => { logger.error(`ws error: ${error.message}`); ws.terminate(); });
    broadcastStatus();
    if (lastFrame && agentAlive && lastAgentStatus?.capturing) ws.send(lastFrame, { binary: true }, (error) => { if (error) ws.terminate(); });
    sendToAgent({ cmd: 'status' });
  });

  async function listen() {
    await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
    // Bind before spawning: a port conflict must not leave an input agent running.
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(config.port, config.host);
    });
    spawnAgent();
    statusTimer = setInterval(() => {
      if (agentAlive && Date.now() - lastAgentResponseAt > 15000) {
        lastAgentError = '原生服务状态响应超时，正在恢复';
        agentAlive = false;
        lastFrame = null;
        lastAgentStatus = null;
        agentState = 'restarting';
        for (const ws of clients) ws.pressedButtons.clear();
        dragOwner = null;
        const child = agent;
        child?.kill();
        const timer = setTimeout(() => { if (child === agent) child.kill('SIGKILL'); }, 1000);
        timer.unref();
        child?.once('close', () => clearTimeout(timer));
        broadcastStatus();
      } else {
        sendToAgent({ cmd: 'status' });
      }
    }, 3000);
    statusTimer.unref();
    heartbeatTimer = setInterval(() => {
      for (const ws of clients) {
        if (!ws.isAlive) {
          releaseInputs(ws);
          ws.terminate();
        } else {
          ws.isAlive = false;
          ws.ping((error) => { if (error) ws.terminate(); });
        }
      }
    }, heartbeatMs);
    heartbeatTimer.unref();
    return server.address();
  }

  function close() {
    if (closePromise) return closePromise;
    shuttingDown = true;
    clearTimeout(agentRestartTimer);
    clearInterval(heartbeatTimer);
    clearInterval(statusTimer);
    closePromise = (async () => {
      for (const ws of clients) { releaseInputs(ws, false); ws.close(1001, 'Server shutting down'); }
      sendToAgent({ cmd: 'releaseInputs' });
      cancelPendingText('服务正在关闭，发送结果未确认');
      settleStatusWaiters();
      const child = agent;
      const childClosed = child ? new Promise((resolve) => {
        child.once('close', resolve);
        child.stdin.end();
        const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
        timer.unref();
        child.once('close', () => clearTimeout(timer));
      }) : Promise.resolve();
      const stopped = new Promise((resolve) => server.close(resolve));
      const timer = setTimeout(() => { for (const ws of clients) ws.terminate(); server.closeAllConnections(); }, 1000);
      timer.unref();
      await Promise.all([stopped, childClosed]);
      clearTimeout(timer);
      wss.close();
      agentState = 'stopped';
      await permissionWrite;
    })();
    return closePromise;
  }

  return { app, server, listen, close, statusPayload };
}
