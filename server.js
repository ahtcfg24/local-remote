// server.js — 局域网远程控制服务端
//
// 架构：
//   浏览器 <—WebSocket(JPEG 帧 / JSON 控制)—> 本服务 <—stdin/stdout—> .build/agent 常驻守护进程
//
// 守护进程负责 ScreenCaptureKit 采集与 CGEvent 输入注入；
// 本服务负责鉴权、帧分发（带背压丢帧）、控制消息顺序转发与守护进程生命周期管理。

import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import qrcode from 'qrcode-terminal';
import { WebSocketServer } from 'ws';
import { loadConfig } from './lib/config.js';
import { extractAccessToken, generateAccessToken, isSameHostOrigin, tokensMatch } from './lib/security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 配置 ----------

const config = loadConfig();
const { host: HOST, port: PORT, fps: FPS, quality: QUALITY, maxWidth: MAX_WIDTH, maxClients: MAX_CLIENTS } = config;
const AGENT_BIN = path.join(__dirname, '.build', 'agent');
const PERMISSION_GUIDE_BIN = path.join(__dirname, '.build', 'permission-guide');
const RUN_DIR = path.join(__dirname, '.run');
const TOKEN_FILE = path.join(RUN_DIR, 'token');
const MAX_TEXT_LENGTH = 2000;
// 客户端积压超过该值时丢帧，避免慢速网络下延迟无限累积
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

// ---------- Token：优先环境变量，否则生成并持久化随机 token ----------

async function loadToken() {
  if (process.env.REMOTE_TOKEN) return process.env.REMOTE_TOKEN;
  try {
    const saved = (await fs.readFile(TOKEN_FILE, 'utf8')).trim();
    if (/^[a-f0-9]{64}$/i.test(saved)) {
      await fs.chmod(TOKEN_FILE, 0o600);
      return saved;
    }
  } catch {
    // 文件不存在则走生成逻辑
  }
  const generated = generateAccessToken();
  await fs.mkdir(RUN_DIR, { recursive: true });
  await fs.writeFile(TOKEN_FILE, `${generated}\n`, { mode: 0o600 });
  return generated;
}

const TOKEN = await loadToken();

// ---------- 守护进程管理 ----------

let agent = null;
let agentAlive = false;
let agentRestartDelay = 1000;
let agentStdoutBuffer = Buffer.alloc(0);
let lastFrame = null;
let lastAgentStatus = null;
let lastAgentError = null;
let agentRestartTimer = null;
let shuttingDown = false;
const statusWaiters = new Set();

function spawnAgent() {
  agent = spawn(AGENT_BIN, [], {
    cwd: __dirname,
    env: {
      ...process.env,
      AGENT_FPS: String(FPS),
      AGENT_QUALITY: String(QUALITY),
      AGENT_MAX_WIDTH: String(MAX_WIDTH),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  agentAlive = true;
  agentStdoutBuffer = Buffer.alloc(0);

  agent.stdout.on('data', (chunk) => {
    agentStdoutBuffer = agentStdoutBuffer.length === 0 ? chunk : Buffer.concat([agentStdoutBuffer, chunk]);
    // 解析 [1 字节类型][4 字节大端长度][负载] 帧协议
    while (agentStdoutBuffer.length >= 5) {
      const type = agentStdoutBuffer[0];
      const length = agentStdoutBuffer.readUInt32BE(1);
      if (agentStdoutBuffer.length < 5 + length) break;
      const payload = agentStdoutBuffer.subarray(5, 5 + length);
      agentStdoutBuffer = agentStdoutBuffer.subarray(5 + length);
      if (type === 0x46) {
        handleAgentFrame(Buffer.from(payload));
      } else if (type === 0x4a) {
        handleAgentJson(payload.toString('utf8'));
      }
    }
  });

  agent.stderr.on('data', (chunk) => {
    console.error(`[agent] ${chunk.toString().trim()}`);
  });

  agent.on('error', (error) => {
    lastAgentError = `agent spawn failed: ${error.message}`;
    console.error(lastAgentError);
  });

  agent.on('exit', (code, signal) => {
    agentAlive = false;
    lastAgentError = `agent exited (code=${code}, signal=${signal})`;
    if (shuttingDown) return;
    console.error(`${lastAgentError}, restarting in ${agentRestartDelay}ms`);
    broadcastJson(statusPayload());
    // 指数退避重启，防止持续崩溃时空转
    agentRestartTimer = setTimeout(() => {
      agentRestartDelay = Math.min(10_000, agentRestartDelay * 2);
      spawnAgent();
    }, agentRestartDelay);
  });
}

function handleAgentFrame(frame) {
  lastFrame = frame;
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN && ws.bufferedAmount < MAX_BUFFERED_BYTES) {
      ws.send(frame, { binary: true });
    }
  }
}

function handleAgentJson(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    console.error(`[agent] invalid json: ${text}`);
    return;
  }
  if (payload.type === 'status') {
    lastAgentStatus = payload;
    lastAgentError = null;
    agentRestartDelay = 1000;
    for (const waiter of statusWaiters) waiter(payload);
    statusWaiters.clear();
    broadcastJson(statusPayload());
  } else if (payload.type === 'error') {
    lastAgentError = payload.message;
    console.error(`[agent] ${payload.message}`);
    broadcastJson(statusPayload());
  }
}

function sendToAgent(command) {
  if (!agentAlive || !agent?.stdin?.writable) return false;
  agent.stdin.write(`${JSON.stringify(command)}\n`);
  return true;
}

// 请求守护进程刷新状态并等待返回，超时则退回缓存值
function refreshAgentStatus(timeoutMs = 800) {
  return new Promise((resolve) => {
    if (!sendToAgent({ cmd: 'status' })) {
      resolve(lastAgentStatus);
      return;
    }
    const timer = setTimeout(() => {
      statusWaiters.delete(waiter);
      resolve(lastAgentStatus);
    }, timeoutMs);
    const waiter = (payload) => {
      clearTimeout(timer);
      resolve(payload);
    };
    statusWaiters.add(waiter);
  });
}

// ---------- HTTP / WebSocket ----------

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const clients = new Set();

app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));

app.use((_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  next();
});

function hasValidToken(rawUrl, authorization = '') {
  return tokensMatch(extractAccessToken(rawUrl, authorization), TOKEN);
}

function requireToken(req, res, next) {
  if (!hasValidToken(req.originalUrl || req.url, req.get('authorization'))) {
    res.status(401).type('text/plain').send('Unauthorized: missing or invalid token.');
    return;
  }
  next();
}

function statusPayload(extra = {}) {
  const status = lastAgentStatus || {};
  return {
    type: 'status',
    screen: { width: status.width || 0, height: status.height || 0 },
    fps: status.fps || FPS,
    capturing: Boolean(status.capturing),
    permissions: {
      screenRecording: status.screenRecording ? 'ok' : 'not_granted',
      accessibility: status.accessibilityTrusted ? 'ok' : 'not_trusted',
    },
    errors: {
      capture: status.captureError || null,
      agent: lastAgentError,
    },
    connectedClients: clients.size,
    ...extra,
  };
}

function sendJson(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcastJson(payload) {
  for (const ws of clients) sendJson(ws, payload);
}

// ---------- 控制消息：浏览器 JSON -> 守护进程命令 ----------

// 过滤客户端传来的修饰键数组（鼠标点击与键盘按键共用）
function sanitizeModifiers(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, 4) : [];
}

function handleControlMessage(ws, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (!message || typeof message.type !== 'string') return;

  const x = Number(message.x) || 0;
  const y = Number(message.y) || 0;
  const button = typeof message.button === 'string' ? message.button : 'left';
  const count = Math.min(3, Math.max(1, Number(message.count) || 1));
  const modifiers = sanitizeModifiers(message.modifiers);

  switch (message.type) {
    case 'pointer_move':
      sendToAgent({ cmd: 'move', x, y });
      break;
    case 'pointer_drag':
      sendToAgent({ cmd: 'drag', x, y, button });
      // 拖拽期间更新按下坐标，断连补发的 up 落在最后位置
      if (ws.pressedButtons?.has(button)) ws.pressedButtons.set(button, { x, y });
      break;
    case 'pointer_down':
      sendToAgent({ cmd: 'down', x, y, button, count, modifiers });
      // 记录按下的按钮与坐标：客户端异常断开时补发 up，防止远端按键永久卡死
      ws.pressedButtons?.set(button, { x, y });
      break;
    case 'pointer_up':
      sendToAgent({ cmd: 'up', x, y, button, count, modifiers });
      ws.pressedButtons?.delete(button);
      break;
    case 'click':
      sendToAgent({ cmd: 'click', x, y, button, count, modifiers });
      break;
    case 'wheel':
      sendToAgent({ cmd: 'wheel', dx: Number(message.dx) || 0, dy: Number(message.dy) || 0 });
      break;
    case 'key_press': {
      const key = String(message.key || '').slice(0, 32);
      // repeat：同一按键连发次数（IME 差分同步删除/移位大段文本时合并为单条消息）
      const repeat = Math.min(2000, Math.max(1, Math.trunc(Number(message.repeat)) || 1));
      if (key) sendToAgent({ cmd: 'key', key, modifiers, repeat });
      break;
    }
    case 'type_text': {
      const text = String(message.text || '').slice(0, MAX_TEXT_LENGTH);
      if (text) sendToAgent({ cmd: 'text', text });
      break;
    }
    case 'ping':
      // 客户端连接探活：回 pong 证明链路存活（iOS 回前台后的僵尸连接检测）
      sendJson(ws, { type: 'pong' });
      break;
    default:
      break;
  }
}

// ---------- 路由 ----------

app.get('/health', (_req, res) => {
  res.type('text/plain').send('ok');
});

app.get('/api/info', requireToken, async (_req, res) => {
  await refreshAgentStatus();
  res.json(statusPayload({ host: HOST, port: PORT }));
});

app.get('/api/permissions/status', requireToken, async (_req, res) => {
  await refreshAgentStatus();
  res.json(statusPayload({ host: HOST, port: PORT }));
});

function launchDetached(file, args = []) {
  const child = spawn(file, args, { cwd: __dirname, detached: true, stdio: 'ignore' });
  child.unref();
}

async function openSettingsPane(name) {
  const panes = {
    screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  };
  const target = panes[name];
  if (!target) throw new Error(`Unknown settings pane: ${name}`);
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/open', [target], { stdio: 'ignore' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`open exited with ${code}`))));
    child.on('error', reject);
  });
}

app.post('/api/permissions/guide', requireToken, async (req, res) => {
  const action = String(req.body?.action || 'open_guide');
  try {
    if (action === 'open_guide') {
      await fs.access(PERMISSION_GUIDE_BIN);
      launchDetached(PERMISSION_GUIDE_BIN, [process.execPath, AGENT_BIN, __dirname]);
    } else if (action === 'open_screen_settings') {
      await openSettingsPane('screen');
    } else if (action === 'open_accessibility_settings') {
      await openSettingsPane('accessibility');
    } else if (action === 'trigger_screen_recording') {
      sendToAgent({ cmd: 'promptScreen' });
    } else if (action === 'trigger_accessibility_prompt') {
      sendToAgent({ cmd: 'promptAccessibility' });
    } else if (action !== 'recheck') {
      res.status(400).json({ error: `Unknown action: ${action}` });
      return;
    }
    await refreshAgentStatus();
    res.json(statusPayload({ host: HOST, port: PORT, action }));
  } catch (error) {
    res.status(500).json({ error: error.message, action });
  }
});

app.use('/public', express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

// 控制台外壳不包含屏幕数据；开放静态页面使浏览器清理地址栏 token 后仍可刷新。
// 所有状态、控制与画面通道仍强制鉴权。
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.on('upgrade', (req, socket, head) => {
  if (!isSameHostOrigin(req.headers.origin, req.headers.host)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!hasValidToken(req.url || '', req.headers.authorization)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  if (clients.size >= MAX_CLIENTS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  clients.add(ws);
  // 跟踪该客户端按下未释放的鼠标按钮（button -> 最后坐标）
  ws.pressedButtons = new Map();
  sendJson(ws, statusPayload());
  // 立即补发最后一帧，新连接秒出画面
  if (lastFrame && ws.readyState === ws.OPEN) {
    ws.send(lastFrame, { binary: true });
  }
  sendToAgent({ cmd: 'status' });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try {
      handleControlMessage(ws, data.toString());
    } catch (error) {
      console.error(`control message failed: ${error.message}`);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    // 客户端异常断开（手机锁屏/被系统回收）时补发未释放的按钮，防止远端左键卡死
    if (ws.pressedButtons?.size) {
      for (const [button, point] of ws.pressedButtons) {
        sendToAgent({ cmd: 'up', x: point.x, y: point.y, button });
      }
      ws.pressedButtons.clear();
    }
    broadcastJson(statusPayload());
  });

  ws.on('error', (error) => {
    console.error(`ws error: ${error.message}`);
  });
});

// ---------- 启动 ----------

function lanAddresses() {
  const result = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const net of interfaces || []) {
      if (net.family === 'IPv4' && !net.internal) result.push(net.address);
    }
  }
  return result;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (agentRestartTimer) clearTimeout(agentRestartTimer);
  for (const ws of clients) ws.close(1001, 'Server shutting down');
  agent?.kill();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

for (const signalName of ['SIGINT', 'SIGTERM']) {
  process.on(signalName, shutdown);
}

try {
  await fs.access(AGENT_BIN);
} catch {
  console.error(`Agent binary not found: ${AGENT_BIN}`);
  console.error('Run "npm run build:native" first.');
  process.exit(1);
}

spawnAgent();

server.listen(PORT, HOST, () => {
  const addresses = lanAddresses();
  const primaryUrl = addresses.length
    ? `http://${addresses[0]}:${PORT}/?token=${TOKEN}`
    : `http://127.0.0.1:${PORT}/?token=${TOKEN}`;
  console.log('');
  console.log('Local Remote Control');
  console.log(`Listening: http://${HOST}:${PORT}/?token=${TOKEN}`);
  for (const address of addresses) {
    console.log(`LAN URL:   http://${address}:${PORT}/?token=${TOKEN}`);
  }
  console.log('');
  console.log('手机扫码打开控制台：');
  qrcode.generate(primaryUrl, { small: true });
  console.log('Security note: LAN only. Do not expose this port to the public internet.');
  console.log('');
});
