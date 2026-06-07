import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const FPS = Math.min(12, Math.max(1, Number(process.env.FPS || 6)));
const FRAME_INTERVAL_MS = Math.round(1000 / FPS);
const TOKEN = process.env.REMOTE_TOKEN || 'local-remote-demo';
const CONTROL_BIN = path.join(__dirname, '.build', 'control');
const SCREENSHOT_BIN = '/usr/sbin/screencapture';
const TMP_DIR = path.join(os.tmpdir(), 'local-remote-control-demo');
const MAX_TEXT_LENGTH = 500;

let latestInfo = {
  width: 0,
  height: 0,
  x: 0,
  y: 0,
  accessibilityTrusted: false,
};
let lastFrameError = null;
let lastControlError = null;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const clients = new Set();

app.disable('x-powered-by');

function hasValidToken(rawUrl) {
  try {
    const url = new URL(rawUrl, `http://${HOST}:${PORT}`);
    return url.searchParams.get('token') === TOKEN;
  } catch {
    return false;
  }
}

function requireToken(req, res, next) {
  if (req.query.token !== TOKEN) {
    res.status(401).type('text/plain').send('Unauthorized: missing or invalid token.');
    return;
  }
  next();
}

function execFileP(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, maxBuffer: 2 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr?.toString?.() || '';
        error.stdout = stdout?.toString?.() || '';
        reject(error);
        return;
      }
      resolve({ stdout: stdout?.toString?.() || '', stderr: stderr?.toString?.() || '' });
    });
  });
}

async function getNativeInfo() {
  try {
    const { stdout } = await execFileP(CONTROL_BIN, ['info']);
    latestInfo = JSON.parse(stdout);
  } catch (error) {
    lastControlError = `Native helper info failed: ${error.stderr || error.message}`;
  }
  return latestInfo;
}

async function captureFrame() {
  await fs.mkdir(TMP_DIR, { recursive: true });
  const file = path.join(TMP_DIR, `frame-${process.pid}-${Date.now()}.jpg`);
  try {
    await execFileP(SCREENSHOT_BIN, ['-x', '-t', 'jpg', file], { timeout: 4000, maxBuffer: 128 * 1024 });
    const frame = await fs.readFile(file);
    lastFrameError = null;
    return frame;
  } catch (error) {
    lastFrameError = error.stderr || error.message;
    return null;
  } finally {
    fs.rm(file, { force: true }).catch(() => {});
  }
}

function statusPayload(extra = {}) {
  return {
    type: 'status',
    screen: latestInfo,
    fps: FPS,
    permissions: {
      screenRecording: lastFrameError ? 'unknown_or_denied' : 'ok',
      accessibility: latestInfo.accessibilityTrusted ? 'ok' : 'not_trusted',
    },
    errors: {
      frame: lastFrameError,
      control: lastControlError,
    },
    ...extra,
  };
}

function sendJson(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastJson(payload) {
  for (const ws of clients) sendJson(ws, payload);
}

function broadcastFrame(frame) {
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN && ws.bufferedAmount < 5 * 1024 * 1024) {
      ws.send(frame, { binary: true });
    }
  }
}

function clampPoint(rawX, rawY) {
  const width = latestInfo.width || 1;
  const height = latestInfo.height || 1;
  const x = Math.min(width - 1, Math.max(0, Number(rawX)));
  const y = Math.min(height - 1, Math.max(0, Number(rawY)));
  return [String(Math.round(x)), String(Math.round(y))];
}

function buttonName(value) {
  if (value === 'right' || value === 2) return 'right';
  if (value === 'middle' || value === 1) return 'middle';
  return 'left';
}

function modifierList(value) {
  if (!Array.isArray(value)) return '';
  return value
    .filter((item) => ['shift', 'control', 'ctrl', 'option', 'alt', 'command', 'cmd', 'meta'].includes(String(item).toLowerCase()))
    .join(',');
}

async function runControl(args) {
  try {
    await execFileP(CONTROL_BIN, args, { timeout: 2000, maxBuffer: 128 * 1024 });
    lastControlError = null;
    return true;
  } catch (error) {
    lastControlError = error.stderr || error.message;
    broadcastJson(statusPayload());
    return false;
  }
}

async function handleControlMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (!message || typeof message.type !== 'string') return;

  switch (message.type) {
    case 'pointer_move': {
      const [x, y] = clampPoint(message.x, message.y);
      await runControl(['move', x, y]);
      break;
    }
    case 'pointer_drag': {
      const [x, y] = clampPoint(message.x, message.y);
      await runControl(['dragmove', x, y, buttonName(message.button)]);
      break;
    }
    case 'pointer_down': {
      const [x, y] = clampPoint(message.x, message.y);
      await runControl(['down', x, y, buttonName(message.button)]);
      break;
    }
    case 'pointer_up': {
      const [x, y] = clampPoint(message.x, message.y);
      await runControl(['up', x, y, buttonName(message.button)]);
      break;
    }
    case 'click': {
      const [x, y] = clampPoint(message.x, message.y);
      await runControl(['click', x, y, buttonName(message.button)]);
      break;
    }
    case 'double_click': {
      const [x, y] = clampPoint(message.x, message.y);
      await runControl(['doubleclick', x, y, buttonName(message.button)]);
      break;
    }
    case 'wheel': {
      await runControl(['wheel', String(Number(message.dx) || 0), String(Number(message.dy) || 0)]);
      break;
    }
    case 'type_text': {
      const text = String(message.text || '').slice(0, MAX_TEXT_LENGTH);
      if (text) await runControl(['type', text]);
      break;
    }
    case 'key_press': {
      const key = String(message.key || '').slice(0, 32);
      if (key) await runControl(['key', key, modifierList(message.modifiers)]);
      break;
    }
    case 'ping':
      break;
    default:
      break;
  }
}

app.get('/api/info', requireToken, async (_req, res) => {
  await getNativeInfo();
  res.json(statusPayload({ host: HOST, port: PORT }));
});

app.use('/public', express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
}));

app.get('/', requireToken, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.on('upgrade', (req, socket, head) => {
  if (!hasValidToken(req.url || '')) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', async (ws) => {
  clients.add(ws);
  await getNativeInfo();
  sendJson(ws, statusPayload({ connectedClients: clients.size }));

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    handleControlMessage(data.toString()).catch((error) => {
      lastControlError = error.message;
      sendJson(ws, statusPayload());
    });
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcastJson(statusPayload({ connectedClients: clients.size }));
  });
});

async function frameLoop() {
  while (true) {
    if (clients.size > 0) {
      await getNativeInfo();
      const frame = await captureFrame();
      if (frame) {
        broadcastFrame(frame);
      } else {
        broadcastJson(statusPayload());
      }
    }
    await new Promise((resolve) => setTimeout(resolve, FRAME_INTERVAL_MS));
  }
}

function lanAddresses() {
  const result = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const net of interfaces || []) {
      if (net.family === 'IPv4' && !net.internal) {
        result.push(net.address);
      }
    }
  }
  return result;
}

server.listen(PORT, HOST, async () => {
  await getNativeInfo();
  const addresses = lanAddresses();
  console.log('');
  console.log('Local Remote Control Demo');
  console.log(`Listening: http://${HOST}:${PORT}/?token=${TOKEN}`);
  for (const address of addresses) {
    console.log(`LAN URL:   http://${address}:${PORT}/?token=${TOKEN}`);
  }
  console.log('');
  console.log('Security note: LAN demo only. Do not expose this port to the public internet.');
  console.log('macOS permissions needed: Screen Recording for screencapture, Accessibility for input control.');
  console.log('');
  frameLoop().catch((error) => {
    console.error('Frame loop failed:', error);
  });
});
