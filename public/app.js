// app.js — 远程控制前端
//
// 分区：网络层 / 视图变换与坐标映射 / 桌面输入 / 触屏输入（触控板+直触）/ 键盘抽屉 / UI 绑定
// 移动端要点：轻点零延迟（clickState 计数）、惯性滚动、拖拽/长按可视反馈、
//   visualViewport 键盘抬升、屏幕保活、后台恢复秒重连、toast 操作反馈。

// ---------- DOM 引用 ----------

const token = new URLSearchParams(window.location.search).get('token') || '';
const $ = (id) => document.getElementById(id);

const canvas = $('screen');
const ctx = canvas.getContext('2d');
const screenWrap = $('screenWrap');
const stage = $('stage');
const emptyState = $('emptyState');
const remoteCursor = $('remoteCursor');
const connectionDot = $('connectionDot');
const connectionLabel = $('connectionLabel');
const statsLabel = $('statsLabel');
const permissionLabel = $('permissionLabel');
const logOutput = $('logOutput');
const controlEnabled = $('controlEnabled');
const zoomReadout = $('zoomReadout');
const panBtn = $('panBtn');
const stageTools = $('stageTools');
const fullscreenBtn = $('fullscreenBtn');
const stageFullscreenBtn = $('stageFullscreenBtn');
const fullscreenExitBtn = $('fullscreenExitBtn');
const copyLinkBtn = $('copyLinkBtn');
const dock = $('dock');
const dockModeBtn = $('dockModeBtn');
const dockModeValue = $('dockModeValue');
const dockKeyboardBtn = $('dockKeyboardBtn');
const dockRightClickBtn = $('dockRightClickBtn');
const dockDragBtn = $('dockDragBtn');
const dockViewBtn = $('dockViewBtn');
const kbdPanel = $('kbdPanel');
const kbdCloseBtn = $('kbdCloseBtn');
const kbdMoreBtn = $('kbdMoreBtn');
const imeInput = $('imeInput');
const bulkTextInput = $('bulkTextInput');
const sendBulkText = $('sendBulkText');
const clearBulkText = $('clearBulkText');
const kbdBulkBtn = $('kbdBulkBtn');
const kbdBulk = $('kbdBulk');
const kbdBulkInput = $('kbdBulkInput');
const kbdBulkCount = $('kbdBulkCount');
const kbdBulkSend = $('kbdBulkSend');
const kbdBulkClear = $('kbdBulkClear');
const authModal = $('authModal');
const authGuideBtn = $('authGuideBtn');
const authModalClose = $('authModalClose');
const authModalStatus = $('authModalStatus');
const connOverlay = $('connOverlay');
const connOverlayText = $('connOverlayText');
const reconnectNowBtn = $('reconnectNowBtn');
const toastEl = $('toast');
const panExitChip = $('panExitChip');
const touchFeedback = $('touchFeedback');
const gestureGuide = $('gestureGuide');
const gestureGuideClose = $('gestureGuideClose');
const gestureHelpBtn = $('gestureHelpBtn');

// ---------- 全局状态 ----------

// 触屏设备判定：pointer: coarse 之外用 maxTouchPoints 兜底——
// 部分浏览器（桌面视口模式/魔改内核）不上报 coarse，但触控交互仍应按移动端处理
const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let hasEverConnected = false;
let lastWsMessageAt = 0;
let screenSize = { width: canvas.width, height: canvas.height };
let cursor = { x: 640, y: 360 };
let cursorInitialized = false;
let touchMode = 'trackpad';
let dragLocked = false;
let panMode = false;
let view = { zoom: 1, rotation: 0, panX: 0, panY: 0 };
const stickyModifiers = new Set();

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;
const TAP_MAX_MS = 300;
const TAP_MAX_TRAVEL = 12;
const MULTI_CLICK_MS = 400; // 连击时间窗（与 nextClickCount 共用）
const LONG_PRESS_MS = 500;
const LONG_PRESS_MAX_TRAVEL = 8; // 长按允许的净位移（防手指抖动误取消，也防慢速移动误触发）
const DIRECT_DRAG_HOLD_MS = 300;
const SCROLL_SPEED = 2.4; // 两指滚动系数（主动滚动与惯性共用）
const FOLLOW_EDGE_MARGIN = 48; // 缩放后光标贴近边缘时视图自动跟随的边距

// ---------- 日志 / toast / 状态显示 ----------

function log(message) {
  const time = new Date().toLocaleTimeString();
  logOutput.textContent = `[${time}] ${message}\n` + logOutput.textContent.split('\n').slice(0, 10).join('\n');
}

let toastTimer = null;

// 移动端 sidebar 隐藏看不到 log，操作反馈用画面区 toast 呈现
function showToast(message, duration = 1400) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, duration);
}

// 统一反馈入口：写日志，移动端同时弹 toast
function notify(message) {
  log(message);
  if (isCoarsePointer) showToast(message);
}

function setConnection(state, label) {
  connectionDot.dataset.state = state;
  connectionLabel.textContent = label;
  // 断线遮罩：连过一次之后的断开/重连才显示，首次加载走 emptyState
  if (state === 'open') {
    connOverlay.hidden = true;
  } else if (hasEverConnected) {
    connOverlayText.textContent = state === 'connecting' ? '连接已断开，正在重连…' : '连接已断开';
    connOverlay.hidden = false;
  }
}

// ---------- 网络层 ----------

let frameCount = 0;
let byteCount = 0;
let decoding = false;
let pendingFrame = null;

async function drawFrame(buffer) {
  // 解码期间只保留最新一帧，防止慢设备上积压导致延迟
  if (decoding) {
    pendingFrame = buffer;
    return;
  }
  decoding = true;
  try {
    const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/jpeg' }));
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    emptyState.hidden = true;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
  } catch (error) {
    log(`绘制屏幕帧失败：${error.message}`);
  } finally {
    decoding = false;
    if (pendingFrame) {
      const next = pendingFrame;
      pendingFrame = null;
      drawFrame(next);
    }
  }
}

function updateStatus(payload) {
  if (payload.screen?.width && payload.screen?.height) {
    screenSize = payload.screen;
    if (!cursorInitialized) {
      cursor = { x: screenSize.width / 2, y: screenSize.height / 2 };
      cursorInitialized = true;
    }
    screenWrap.style.setProperty('--screen-ratio', String(screenSize.width / screenSize.height));
    positionRemoteCursor();
  }

  const screenOk = payload.permissions?.screenRecording === 'ok';
  const accessOk = payload.permissions?.accessibility === 'ok';
  const perms = [];
  perms.push(screenOk ? '录屏✓' : '录屏待授权');
  perms.push(accessOk ? '控制✓' : '辅助功能待授权');
  if (payload.capturing === false && screenOk) perms.push('采集重连中');
  permissionLabel.textContent = perms.join(' · ');
  // 移动端顶栏空间宝贵：权限全部正常时隐藏标签，异常时高亮显示并可点击打开授权引导
  permissionLabel.hidden = isCoarsePointer && screenOk && accessOk && payload.capturing !== false;
  permissionLabel.classList.toggle('perm-warn', !(screenOk && accessOk));

  const errors = [payload.errors?.capture, payload.errors?.agent].filter(Boolean);
  if (errors.length) log(errors.join('\n'));
}

function connect() {
  clearTimeout(reconnectTimer);
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // 用局部变量捕获本次连接：旧连接晚到的事件（socket !== ws）一律忽略，
  // 防止 reconnectNow 后旧 close 事件再排定重连、孤儿化新连接
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
  socket.binaryType = 'arraybuffer';
  ws = socket;
  setConnection('connecting', '连接中');

  socket.addEventListener('open', () => {
    if (socket !== ws) return;
    clearTimeout(reconnectTimer);
    hasEverConnected = true;
    setConnection('open', '已连接');
    reconnectDelay = 1000;
    log('已连接');
    if (!isCoarsePointer) canvas.focus();
  });

  socket.addEventListener('message', (event) => {
    if (socket !== ws) return;
    lastWsMessageAt = performance.now();
    if (typeof event.data === 'string') {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'status') updateStatus(payload);
        // pong 仅用于连接探活，收到即代表链路存活，无需处理内容
      } catch {
        log(event.data);
      }
      return;
    }
    frameCount += 1;
    byteCount += event.data.byteLength;
    drawFrame(event.data);
  });

  socket.addEventListener('close', () => {
    if (socket !== ws) return;
    setConnection('closed', '已断开');
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(5000, reconnectDelay + 1000);
  });

  socket.addEventListener('error', () => {
    if (socket !== ws) return;
    setConnection('closed', '连接错误');
  });
}

// 立即重连：清空退避计时，关闭旧连接后重建
function reconnectNow() {
  clearTimeout(reconnectTimer);
  reconnectDelay = 1000;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    try {
      ws.close();
    } catch {
      // 关闭失败不影响重建
    }
  }
  connect();
}

// 探测僵尸连接：iOS 回前台后 readyState 可能仍是 OPEN 但底层 TCP 已死。
// 发一个 ping（服务端回 pong），2 秒内没有任何消息则强制重连。
function probeConnection() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const probeStart = performance.now();
  try {
    ws.send(JSON.stringify({ type: 'ping' }));
  } catch {
    reconnectNow();
    return;
  }
  setTimeout(() => {
    if (ws && ws.readyState === WebSocket.OPEN && lastWsMessageAt < probeStart) {
      log('连接无响应，重新连接');
      reconnectNow();
    }
  }, 2000);
}

// 绕过 controlEnabled 开关的发送通道：按下状态释放等安全消息专用
function sendRaw(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function send(payload) {
  if (!controlEnabled.checked) return;
  sendRaw(payload);
}

// 指针移动/拖拽节流：16ms 内只发最新位置
let moveTimer = null;
let pendingMove = null;
let lastMoveSent = 0;

function sendPointerMove(type, point, button = 'left') {
  pendingMove = { type, x: point.x, y: point.y, button };
  const now = performance.now();
  if (now - lastMoveSent >= 16) {
    flushMove();
    return;
  }
  if (!moveTimer) {
    moveTimer = setTimeout(flushMove, 16 - (now - lastMoveSent));
  }
}

function flushMove() {
  clearTimeout(moveTimer);
  moveTimer = null;
  if (!pendingMove) return;
  lastMoveSent = performance.now();
  send(pendingMove);
  pendingMove = null;
}

// 每秒刷新帧率/带宽统计（移动端只显示帧率，节省顶栏空间）
setInterval(() => {
  const mb = byteCount / (1024 * 1024);
  statsLabel.textContent = isCoarsePointer
    ? `${frameCount}fps`
    : `${screenSize.width}×${screenSize.height} · ${frameCount}fps · ${mb.toFixed(1)}MB/s`;
  frameCount = 0;
  byteCount = 0;
}, 1000);

// ---------- 屏幕保活 ----------

// 远程操控中手机自动锁屏会断开会话。优先用标准 Wake Lock API；
// 本项目常以 http://192.168.x.x 访问（非安全上下文），wakeLock 不存在时
// 回退为播放内联的 2x2 静音循环视频阻止锁屏（NoSleep 方案，纯本地资源）。
const WAKE_VIDEO_SRC =
  'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAANNbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAJxAAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAnd0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAJxAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAIAAAACAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAACcQAAAAAAABAAAAAAHvbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAACgABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABmm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAVpzdGJsAAAAunN0c2QAAAAAAAAAAQAAAKphdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAIAAgBIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDAgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAMGF2Y0MBQsAK/+EAGGdCwArZH4iIwEQAAAMABAAAAwAIPEiZIAEABWjLg8sgAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAAkcAAAAAAAAAGHN0dHMAAAAAAAAAAQAAAAoAAEAAAAAAFHN0c3MAAAAAAAAAAQAAAAEAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAoAAAABAAAAPHN0c3oAAAAAAAAAAAAAAAoAAAKGAAAACgAAAAoAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAAFHN0Y28AAAAAAAAAAQAAA30AAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYyLjEyLjEwMAAAAAhmcmVlAAAC4W1kYXQAAAJwBgX//2zcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0xIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAADmWIhAX///8PRQABV5+AAAAABkGaOAv6gAAAAAZBmlQC/qAAAAAFQZpgF/UAAAAFQZqAF/UAAAAFQZqgF/UAAAAFQZrAF/UAAAAFQZrgF/UAAAAFQZsAFvUAAAAFQZsgFfU=';

let wakeLockSentinel = null;
let keepAwakeVideo = null;

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return false;
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener('release', () => {
      wakeLockSentinel = null;
    });
    return true;
  } catch (error) {
    log(`屏幕常亮申请失败：${error.message}`);
    return false;
  }
}

function ensureKeepAwakeVideo() {
  if (keepAwakeVideo) return keepAwakeVideo;
  const video = document.createElement('video');
  video.setAttribute('playsinline', '');
  video.muted = true;
  video.loop = true;
  video.src = WAKE_VIDEO_SRC;
  video.style.cssText = 'position:fixed;left:-4px;top:-4px;width:2px;height:2px;opacity:0.01;pointer-events:none;';
  document.body.appendChild(video);
  keepAwakeVideo = video;
  return video;
}

async function keepAwake() {
  if (wakeLockSentinel) return;
  if (await acquireWakeLock()) return;
  if (!isCoarsePointer) return;
  // 视频保活必须由用户手势触发 play，失败则等下一次手势再试
  try {
    await ensureKeepAwakeVideo().play();
  } catch {
    // 尚无用户手势，静默等待
  }
}

// ---------- 视图变换与坐标映射 ----------

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function applyViewTransform() {
  canvas.style.setProperty('--view-zoom', view.zoom);
  canvas.style.setProperty('--view-rotation', `${view.rotation}deg`);
  canvas.style.setProperty('--view-pan-x', `${view.panX}px`);
  canvas.style.setProperty('--view-pan-y', `${view.panY}px`);
  screenWrap.classList.toggle('is-rotated', view.rotation !== 0);
  zoomReadout.textContent = `${Math.round(view.zoom * 100)}%`;
  document.querySelectorAll('[data-view-action="landscape"]').forEach((button) => {
    button.classList.toggle('active', view.rotation !== 0);
  });
  positionRemoteCursor();
}

function setZoom(nextZoom, origin = null) {
  const previous = view.zoom;
  view.zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  if (origin && previous !== view.zoom) {
    view.panX = origin.x - (origin.x - view.panX) * (view.zoom / previous);
    view.panY = origin.y - (origin.y - view.panY) * (view.zoom / previous);
  }
  applyViewTransform();
}

function resetView() {
  view = { zoom: 1, rotation: view.rotation, panX: 0, panY: 0 };
  applyViewTransform();
}

// 画布未变换（zoom/pan 前）的布局中心点（client 坐标），缩放焦点补偿的基准。
// 移动端画面顶部对齐后画布中心不再等于容器中心，不能用容器中心代替
function canvasLayoutCenter() {
  const wrapRect = screenWrap.getBoundingClientRect();
  return {
    x: wrapRect.left + canvas.offsetLeft + canvas.offsetWidth / 2,
    y: wrapRect.top + canvas.offsetTop + canvas.offsetHeight / 2,
  };
}

// 画布局部坐标（含旋转）→ 远程屏幕坐标
function rotatePointForScreen(localX, localY, rect) {
  const rotation = ((view.rotation % 360) + 360) % 360;
  if (rotation === 90) {
    return { x: (localY / rect.height) * screenSize.width, y: (1 - localX / rect.width) * screenSize.height };
  }
  if (rotation === 270) {
    return { x: (1 - localY / rect.height) * screenSize.width, y: (localX / rect.width) * screenSize.height };
  }
  if (rotation === 180) {
    return { x: (1 - localX / rect.width) * screenSize.width, y: (1 - localY / rect.height) * screenSize.height };
  }
  return { x: (localX / rect.width) * screenSize.width, y: (localY / rect.height) * screenSize.height };
}

function eventToScreenPoint(event) {
  const rect = canvas.getBoundingClientRect();
  const mapped = rotatePointForScreen(event.clientX - rect.left, event.clientY - rect.top, rect);
  return {
    x: clamp(mapped.x, 0, screenSize.width - 1),
    y: clamp(mapped.y, 0, screenSize.height - 1),
  };
}

// 远程屏幕坐标 → 页面坐标（用于远程光标覆盖层定位）
function screenPointToClient(point) {
  const rect = canvas.getBoundingClientRect();
  const rotation = ((view.rotation % 360) + 360) % 360;
  let localX;
  let localY;
  if (rotation === 90) {
    localX = (1 - point.y / screenSize.height) * rect.width;
    localY = (point.x / screenSize.width) * rect.height;
  } else if (rotation === 270) {
    localX = (point.y / screenSize.height) * rect.width;
    localY = (1 - point.x / screenSize.width) * rect.height;
  } else if (rotation === 180) {
    localX = (1 - point.x / screenSize.width) * rect.width;
    localY = (1 - point.y / screenSize.height) * rect.height;
  } else {
    localX = (point.x / screenSize.width) * rect.width;
    localY = (point.y / screenSize.height) * rect.height;
  }
  return { x: rect.left + localX, y: rect.top + localY };
}

function positionRemoteCursor() {
  const wrapRect = screenWrap.getBoundingClientRect();
  const client = screenPointToClient(cursor);
  remoteCursor.style.left = `${client.x - wrapRect.left}px`;
  remoteCursor.style.top = `${client.y - wrapRect.top}px`;
  // 放大画面时光标同步放大一点，避免在细节中丢失
  remoteCursor.style.setProperty('--cursor-scale', String(clamp(view.zoom * 0.6, 1, 1.6)));
  // 触控板模式常显；直触模式仅拖拽期间显示（此时光标是唯一的位置参照）
  remoteCursor.hidden = !(isCoarsePointer && (touchMode === 'trackpad' || touchDragging || dragLocked));
}

// 光标脉冲动画：右键等瞬时操作的视觉确认
let cursorPulseTimer = null;

function cursorPulse() {
  remoteCursor.classList.remove('pulse');
  // 强制 reflow 以重启动画
  void remoteCursor.offsetWidth;
  remoteCursor.classList.add('pulse');
  clearTimeout(cursorPulseTimer);
  cursorPulseTimer = setTimeout(() => remoteCursor.classList.remove('pulse'), 400);
}

// 缩放后光标贴近舞台边缘时自动平移视图跟随，避免光标移出可视区丢失
function followCursorIntoView() {
  if (touchMode !== 'trackpad' || view.zoom <= 1 || panMode) return;
  const stageRect = stage.getBoundingClientRect();
  if (!stageRect.width || !stageRect.height) return;
  const marginX = Math.min(FOLLOW_EDGE_MARGIN, stageRect.width / 4);
  const marginY = Math.min(FOLLOW_EDGE_MARGIN, stageRect.height / 4);
  const client = screenPointToClient(cursor);
  let dx = 0;
  let dy = 0;
  if (client.x < stageRect.left + marginX) dx = stageRect.left + marginX - client.x;
  else if (client.x > stageRect.right - marginX) dx = stageRect.right - marginX - client.x;
  if (client.y < stageRect.top + marginY) dy = stageRect.top + marginY - client.y;
  else if (client.y > stageRect.bottom - marginY) dy = stageRect.bottom - marginY - client.y;
  if (!dx && !dy) return;
  // 钳制平移量，防止画布被推出舞台只剩黑底
  const cRect = canvas.getBoundingClientRect();
  const maxPanX = Math.max(0, (cRect.width - stageRect.width) / 2) + stageRect.width / 2;
  const maxPanY = Math.max(0, (cRect.height - stageRect.height) / 2) + stageRect.height / 2;
  view.panX = clamp(view.panX + dx, -maxPanX, maxPanX);
  view.panY = clamp(view.panY + dy, -maxPanY, maxPanY);
  applyViewTransform();
}

function moveCursorBy(dx, dy) {
  cursor = {
    x: clamp(cursor.x + dx, 0, screenSize.width - 1),
    y: clamp(cursor.y + dy, 0, screenSize.height - 1),
  };
  positionRemoteCursor();
  followCursorIntoView();
}

function setCursor(point) {
  cursor = point;
  positionRemoteCursor();
}

// ---------- 修饰键与按键发送 ----------

function currentModifiers() {
  return Array.from(stickyModifiers);
}

function clearStickyModifiers() {
  stickyModifiers.clear();
  document.querySelectorAll('[data-modifier]').forEach((button) => button.classList.remove('active'));
}

// 一次性取用粘滞修饰键：点击类操作附带修饰键后立即清除（与按键语义一致）
function takeModifiers() {
  const mods = currentModifiers();
  if (mods.length) clearStickyModifiers();
  return mods;
}

// 桌面端指针事件上的物理修饰键（支持 ⌘/⇧/⌥/⌃ + 点击）
function pointerEventModifiers(event) {
  const mods = [];
  if (event.shiftKey) mods.push('shift');
  if (event.ctrlKey) mods.push('control');
  if (event.altKey) mods.push('option');
  if (event.metaKey) mods.push('command');
  return mods;
}

function sendKey(key, modifiers = null) {
  const mods = modifiers ?? currentModifiers();
  send({ type: 'key_press', key, modifiers: mods });
  if (!modifiers) clearStickyModifiers();
}

// ---------- 点击计数（让远程端识别真双击）----------

let clickTrack = { time: 0, x: 0, y: 0, count: 0 };

// radius：判定“同一位置连击”的距离（远程屏幕像素）。
// 直触模式手指精度低，调用方按画布缩放比例放大该值。
function nextClickCount(point, radius = 8) {
  const now = performance.now();
  const near = Math.hypot(point.x - clickTrack.x, point.y - clickTrack.y) < radius;
  clickTrack = {
    time: now,
    x: point.x,
    y: point.y,
    count: now - clickTrack.time < MULTI_CLICK_MS && near ? Math.min(3, clickTrack.count + 1) : 1,
  };
  return clickTrack.count;
}

// 触屏连击判定半径：约 12 CSS px 换算成远程屏幕像素
function touchClickRadius() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return 8;
  return Math.max(8, 12 * (screenSize.width / rect.width));
}

// ---------- 桌面端鼠标/键盘输入 ----------

const mouseButtonNames = ['left', 'middle', 'right'];
let desktopButtonDown = null;

// 指针事件挂在 screenWrap 上：触控板/平移模式下画布外的黑边也是有效操作面
// （画面顶部对齐后，下方黑边正是拇指最顺手的触控板区域）。
// 直触与桌面鼠标仍只响应画布本体——黑边坐标会钳到屏幕边缘，误触风险高
function acceptsPointerDown(event) {
  if (event.target === canvas) return true;
  if (event.target !== screenWrap || event.pointerType !== 'touch') return false;
  return touchMode === 'trackpad' || panMode;
}

screenWrap.addEventListener('pointerdown', (event) => {
  if (!acceptsPointerDown(event)) return;
  if (event.pointerType === 'touch') {
    handleTouchDown(event);
    return;
  }
  screenWrap.setPointerCapture?.(event.pointerId);
  canvas.focus();
  const point = eventToScreenPoint(event);
  setCursor(point);
  const button = mouseButtonNames[event.button] || 'left';
  desktopButtonDown = button;
  send({ type: 'pointer_down', ...point, button, count: nextClickCount(point), modifiers: pointerEventModifiers(event) });
  event.preventDefault();
});

screenWrap.addEventListener('pointermove', (event) => {
  if (event.pointerType === 'touch') {
    handleTouchMove(event);
    return;
  }
  // 黑边上的悬停不产生远程事件；按下拖拽因指针捕获照常跟随
  if (!desktopButtonDown && event.target !== canvas) return;
  const point = eventToScreenPoint(event);
  setCursor(point);
  if (desktopButtonDown) {
    sendPointerMove('pointer_drag', point, desktopButtonDown);
  } else {
    sendPointerMove('pointer_move', point);
  }
});

screenWrap.addEventListener('pointerup', (event) => {
  if (event.pointerType === 'touch') {
    handleTouchUp(event);
    return;
  }
  if (!desktopButtonDown && event.target !== canvas) return;
  const point = eventToScreenPoint(event);
  setCursor(point);
  if (desktopButtonDown) {
    flushMove();
    send({ type: 'pointer_up', ...point, button: desktopButtonDown, count: clickTrack.count, modifiers: pointerEventModifiers(event) });
    desktopButtonDown = null;
  }
  event.preventDefault();
});

screenWrap.addEventListener('pointercancel', (event) => {
  if (event.pointerType === 'touch') {
    handleTouchCancel(event);
    return;
  }
  if (desktopButtonDown) {
    send({ type: 'pointer_up', ...cursor, button: desktopButtonDown });
    desktopButtonDown = null;
  }
});

screenWrap.addEventListener('contextmenu', (event) => event.preventDefault());

screenWrap.addEventListener(
  'wheel',
  (event) => {
    // Ctrl/⌘ + 滚轮缩放本地视图，其余透传远程滚动
    if (event.ctrlKey || event.metaKey) {
      const center = canvasLayoutCenter();
      const origin = { x: event.clientX - center.x, y: event.clientY - center.y };
      setZoom(view.zoom * (event.deltaY < 0 ? 1.12 : 0.88), origin);
    } else {
      const scale = event.deltaMode === 1 ? 16 : 1;
      send({ type: 'wheel', dx: event.deltaX * scale, dy: event.deltaY * scale });
    }
    event.preventDefault();
  },
  { passive: false },
);

const namedKeyMap = {
  Enter: 'enter', Escape: 'escape', Backspace: 'backspace', Delete: 'forwarddelete',
  Tab: 'tab', ' ': 'space', ArrowLeft: 'arrowleft', ArrowRight: 'arrowright',
  ArrowUp: 'arrowup', ArrowDown: 'arrowdown', Home: 'home', End: 'end',
  PageUp: 'pageup', PageDown: 'pagedown', CapsLock: 'capslock',
  F1: 'f1', F2: 'f2', F3: 'f3', F4: 'f4', F5: 'f5', F6: 'f6',
  F7: 'f7', F8: 'f8', F9: 'f9', F10: 'f10', F11: 'f11', F12: 'f12',
};

canvas.addEventListener('keydown', (event) => {
  const modifiers = [];
  if (event.shiftKey) modifiers.push('shift');
  if (event.ctrlKey) modifiers.push('control');
  if (event.altKey) modifiers.push('option');
  if (event.metaKey) modifiers.push('command');

  if (namedKeyMap[event.key]) {
    sendKey(namedKeyMap[event.key], modifiers);
    event.preventDefault();
    return;
  }
  if (event.key.length === 1) {
    if (modifiers.length && !(modifiers.length === 1 && modifiers[0] === 'shift')) {
      // 组合快捷键（如 ⌘C）用键码发送
      sendKey(event.key.toLowerCase(), modifiers);
    } else {
      send({ type: 'type_text', text: event.key });
    }
    event.preventDefault();
  }
});

// ---------- 触屏输入 ----------

const touches = new Map();
let longPressTimer = null;
let suppressTap = false;
let touchDragging = false;
let dragArmed = false; // 触控板：双击后按住 → 移动即拖拽
let dragReady = false; // 直触：按住超过阈值 → 移动即拖拽（不移动保持长按右键可达）
let directHoldTimer = null;
let twoFinger = null;
let panPointerId = null;

function cancelLongPress() {
  clearTimeout(longPressTimer);
  longPressTimer = null;
}

function clearDirectHold() {
  clearTimeout(directHoldTimer);
  directHoldTimer = null;
}

// 触点净位移（区别于 travel 的累计路程，用于长按判定，抗抖动）
function touchDisplacement(info) {
  return Math.hypot(info.x - info.startX, info.y - info.startY);
}

// ---------- 触点可视反馈（长按充能环 / 触发脉冲）----------

let feedbackTimer = null;

function showTouchFeedback(className, clientX, clientY) {
  touchFeedback.style.left = `${clientX}px`;
  touchFeedback.style.top = `${clientY}px`;
  touchFeedback.className = `touch-feedback ${className}`;
  touchFeedback.hidden = false;
}

function hideTouchFeedback() {
  clearTimeout(feedbackTimer);
  feedbackTimer = null;
  touchFeedback.hidden = true;
  touchFeedback.className = 'touch-feedback';
}

// 手指按住 180ms 未移动后显示右键充能环（动画时长对齐 500ms 长按阈值）
function scheduleTouchFeedback(pointerId) {
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    const info = touches.get(pointerId);
    if (!info || touches.size !== 1 || touchDragging || suppressTap) return;
    if (touchDisplacement(info) > LONG_PRESS_MAX_TRAVEL) return;
    showTouchFeedback('charge-right', info.x, info.y);
  }, 180);
}

function feedbackPop(clientX, clientY, className) {
  showTouchFeedback(className, clientX, clientY);
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(hideTouchFeedback, 400);
}

// ---------- 触点涟漪（轻点确认）----------

function spawnRipple(clientX, clientY) {
  const stageRect = stage.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'ripple';
  el.style.left = `${clientX - stageRect.left}px`;
  el.style.top = `${clientY - stageRect.top}px`;
  stage.appendChild(el);
  const cleanup = () => el.remove();
  el.addEventListener('animationend', cleanup, { once: true });
  // 动画事件丢失时的兜底清理，防止节点泄漏
  setTimeout(cleanup, 700);
}

// ---------- 惯性滚动 ----------

let momentum = null;
// 最近一次 pointerdown 是否截停了惯性（截停轻点不产生点击）
let momentumStoppedByTouch = false;

function cancelMomentum() {
  if (!momentum) return;
  cancelAnimationFrame(momentum.raf);
  momentum = null;
}

function startMomentum(vx, vy) {
  cancelMomentum();
  momentum = { vx, vy, lastT: performance.now(), raf: 0 };
  const step = (t) => {
    if (!momentum) return;
    const dt = Math.min(50, Math.max(1, t - momentum.lastT));
    momentum.lastT = t;
    const rotated = rotateDelta(momentum.vx * dt, momentum.vy * dt);
    send({ type: 'wheel', dx: -rotated.dx * SCROLL_SPEED, dy: -rotated.dy * SCROLL_SPEED });
    // 帧率无关的指数衰减
    const decay = Math.pow(0.94, dt / 16.7);
    momentum.vx *= decay;
    momentum.vy *= decay;
    if (Math.hypot(momentum.vx, momentum.vy) < 0.02) {
      momentum = null;
      return;
    }
    momentum.raf = requestAnimationFrame(step);
  };
  momentum.raf = requestAnimationFrame(step);
}

// 两指滚动松手时按释放速度启动惯性（用最近 120ms 的中点轨迹估算速度）
function maybeStartMomentum(gesture) {
  const now = performance.now();
  const recent = gesture.samples.filter((s) => now - s.t < 120);
  if (recent.length < 2) return;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const dt = last.t - first.t;
  if (dt < 10) return;
  let vx = (last.x - first.x) / dt;
  let vy = (last.y - first.y) / dt;
  const speed = Math.hypot(vx, vy);
  if (speed < 0.35) return; // 慢速松手不启动惯性
  const scale = Math.min(speed, 5) / speed; // 限制最大初速
  startMomentum(vx * scale, vy * scale);
}

// ---------- 触控板加速度 ----------

// 根据滑动速度调节灵敏度：慢速精确、快速甩动一次横穿全屏。
// 速度经 EMA 平滑，避免 touchmove 抖动导致增益跳变、指针发飘。
let smoothedSpeed = 0;

function trackpadAcceleration(dx, dy, dtMs) {
  const speed = Math.hypot(dx, dy) / Math.max(1, dtMs);
  smoothedSpeed = smoothedSpeed * 0.7 + speed * 0.3;
  return clamp(0.7 + Math.pow(smoothedSpeed, 1.35) * 3.4, 0.7, 8);
}

function beginRemoteDrag(point) {
  touchDragging = true;
  remoteCursor.classList.add('dragging');
  navigator.vibrate?.(10);
  send({ type: 'pointer_down', ...point, button: 'left', modifiers: takeModifiers() });
  positionRemoteCursor();
}

function endRemoteDrag(point) {
  if (!touchDragging) return;
  touchDragging = false;
  remoteCursor.classList.remove('dragging');
  flushMove();
  send({ type: 'pointer_up', ...point, button: 'left' });
  positionRemoteCursor();
}

function handleTouchDown(event) {
  screenWrap.setPointerCapture?.(event.pointerId);
  const now = performance.now();
  touches.set(event.pointerId, {
    x: event.clientX,
    y: event.clientY,
    startX: event.clientX,
    startY: event.clientY,
    startTime: now,
    travel: 0,
    lastTime: now,
  });
  event.preventDefault();

  if (panMode && touches.size === 1) {
    panPointerId = event.pointerId;
    return;
  }
  // 平移进行中落下的额外手指完全惰性化：不参与双指手势也不产生轻点/长按
  if (panPointerId !== null) {
    touches.delete(event.pointerId);
    return;
  }

  if (touches.size === 2) {
    // 进入双指手势：取消单指的一切待定行为
    cancelLongPress();
    clearDirectHold();
    hideTouchFeedback();
    dragArmed = false;
    dragReady = false;
    // 新双指手势成立，清除上一轮手势留下的残余标记
    touches.forEach((t) => {
      t.inGesture = false;
    });
    const points = Array.from(touches.values());
    const mid = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
    twoFinger = {
      mode: null,
      startTime: now,
      startDistance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) || 1,
      lastMid: mid,
      startMid: mid,
      startZoom: view.zoom,
      startPanX: view.panX,
      startPanY: view.panY,
      samples: [{ t: now, x: mid.x, y: mid.y }],
    };
    return;
  }
  if (touches.size > 2) {
    twoFinger = null;
    // 参与过三指以上手势的触点抬起时不得产生轻点
    suppressTap = true;
    return;
  }

  // 惯性滚动被本次触摸截停时，抬手不产生点击（对齐原生触屏惯例）
  suppressTap = momentumStoppedByTouch;
  dragReady = false;
  smoothedSpeed = 0;

  // 触控板：上次点击后快速再按下 → 预备拖拽（移动即从当前光标位置开始拖拽，
  // 快速抬起则由 nextClickCount 自然生成 clickState=2 的真双击）
  dragArmed = touchMode === 'trackpad' && now - clickTrack.time < MULTI_CLICK_MS && clickTrack.count >= 1;

  if (touchMode === 'direct') {
    const point = eventToScreenPoint(event);
    setCursor(point);
    // 按住超过阈值进入“拖拽就绪”：不立即按下鼠标，移动才真正开始拖拽，
    // 静止继续按住则让位给 500ms 长按右键（两个手势不再互相吞掉）
    directHoldTimer = setTimeout(() => {
      const info = touches.get(event.pointerId);
      if (info && info.travel < TAP_MAX_TRAVEL && touches.size === 1 && !touchDragging) {
        dragReady = true;
        // 记录就绪时的累计路程基准：只有此后的新增移动才触发拖拽，
        // 避免落指微动预支阈值导致静止长按右键永远无法到达
        info.travelAtReady = info.travel;
        navigator.vibrate?.(10);
        feedbackPop(info.x, info.y, 'pop-ready');
      }
    }, DIRECT_DRAG_HOLD_MS);
  }

  // 长按（未移动）→ 右键；双击后按住的意图是拖拽，长按右键让位
  if (!dragArmed) {
    longPressTimer = setTimeout(() => {
      const info = touches.get(event.pointerId);
      if (info && touchDisplacement(info) <= LONG_PRESS_MAX_TRAVEL && touches.size === 1 && !touchDragging && !suppressTap) {
        suppressTap = true;
        dragReady = false;
        const point = touchMode === 'direct' ? eventFromInfo(info) : cursor;
        send({ type: 'click', ...point, button: 'right', count: 1, modifiers: takeModifiers() });
        navigator.vibrate?.(20);
        feedbackPop(info.x, info.y, 'pop-fired');
        cursorPulse();
        notify('长按 → 右键');
      }
    }, LONG_PRESS_MS);
    scheduleTouchFeedback(event.pointerId);
  }
}

// 将触点当前位置换算为远程屏幕坐标（直触模式用）
function eventFromInfo(info) {
  const rect = canvas.getBoundingClientRect();
  const mapped = rotatePointForScreen(info.x - rect.left, info.y - rect.top, rect);
  return {
    x: clamp(mapped.x, 0, screenSize.width - 1),
    y: clamp(mapped.y, 0, screenSize.height - 1),
  };
}

function handleTouchMove(event) {
  const info = touches.get(event.pointerId);
  if (!info) return;
  const dx = event.clientX - info.x;
  const dy = event.clientY - info.y;
  const now = performance.now();
  const dt = now - info.lastTime;
  info.x = event.clientX;
  info.y = event.clientY;
  info.lastTime = now;
  event.preventDefault();

  // 参与过多指手势的残余触点：坐标照常更新（供下一轮双指手势取新鲜基准），
  // 但不累计 travel、不产生任何动作，避免被当作全新单指手势导致光标漂移
  if (info.inGesture) return;
  info.travel += Math.abs(dx) + Math.abs(dy);

  // 长按取消用净位移判据（与长按回调一致，抗原地抖动的累计误差）
  if (touchDisplacement(info) > LONG_PRESS_MAX_TRAVEL) {
    cancelLongPress();
    hideTouchFeedback();
  }

  if (panPointerId === event.pointerId) {
    view.panX += dx;
    view.panY += dy;
    applyViewTransform();
    return;
  }

  if (touches.size === 2 && twoFinger) {
    handleTwoFingerMove();
    return;
  }
  if (touches.size !== 1) return;

  if (touchMode === 'trackpad') {
    if (dragArmed && !touchDragging && touchDisplacement(info) > LONG_PRESS_MAX_TRAVEL) {
      // 双击-按住-显著移动：从当前光标位置开始拖拽（净位移判据，抖动不误触发）
      beginRemoteDrag(cursor);
    }
    const accel = trackpadAcceleration(dx, dy, dt);
    // 视图旋转 90° 时，手指位移也旋转映射，保证方向直觉一致
    const rotated = rotateDelta(dx * accel, dy * accel);
    moveCursorBy(rotated.dx, rotated.dy);
    sendPointerMove(touchDragging || dragLocked ? 'pointer_drag' : 'pointer_move', cursor);
    return;
  }

  // 直触模式：移动即移动光标（悬停），拖拽就绪后再有新增移动才开始拖拽
  const point = eventToScreenPoint(event);
  setCursor(point);
  if (!touchDragging && dragReady && info.travel - (info.travelAtReady ?? 0) > 4) {
    beginRemoteDrag(point);
  }
  if (touchDragging || dragLocked) {
    sendPointerMove('pointer_drag', point);
  } else if (info.travel > TAP_MAX_TRAVEL) {
    clearDirectHold();
    sendPointerMove('pointer_move', point);
  }
}

function rotateDelta(dx, dy) {
  const rotation = ((view.rotation % 360) + 360) % 360;
  if (rotation === 90) return { dx: dy, dy: -dx };
  if (rotation === 270) return { dx: -dy, dy: dx };
  if (rotation === 180) return { dx: -dx, dy: -dy };
  return { dx, dy };
}

function handleTwoFingerMove() {
  const points = Array.from(touches.values());
  if (points.length < 2 || !twoFinger) return;
  const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) || 1;
  const mid = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
  const now = performance.now();

  // 记录中点轨迹用于松手时的惯性速度估算（只保留最近 150ms）
  twoFinger.samples.push({ t: now, x: mid.x, y: mid.y });
  while (twoFinger.samples.length > 2 && now - twoFinger.samples[0].t > 150) {
    twoFinger.samples.shift();
  }

  // 手势判定：距离变化与中点位移同时累积、谁显著谁赢（比较式竞争），
  // 避免捏合起手时中点先漂移 10px 被误锁成滚动
  if (!twoFinger.mode) {
    const distanceChange = Math.abs(distance - twoFinger.startDistance);
    const midTravel = Math.hypot(mid.x - twoFinger.startMid.x, mid.y - twoFinger.startMid.y);
    if (distanceChange > 24 && distanceChange > midTravel * 1.4) twoFinger.mode = 'pinch';
    else if (midTravel > 12 && midTravel > distanceChange) twoFinger.mode = 'scroll';
  }

  if (twoFinger.mode === 'pinch') {
    const center = canvasLayoutCenter();
    const origin = { x: mid.x - center.x, y: mid.y - center.y };
    setZoom(twoFinger.startZoom * (distance / twoFinger.startDistance), origin);
  } else if (twoFinger.mode === 'scroll') {
    const rotated = rotateDelta(mid.x - twoFinger.lastMid.x, mid.y - twoFinger.lastMid.y);
    // 内容跟随手指的自然滚动方向
    send({ type: 'wheel', dx: -rotated.dx * SCROLL_SPEED, dy: -rotated.dy * SCROLL_SPEED });
  }
  twoFinger.lastMid = mid;
}

// 轻点：立即发送 down/up（clickState 由 nextClickCount 计数），
// 第二击 400ms 内落在近旁自动升级为 clickState=2 的真双击——零点击延迟
function sendTapClick(point, info) {
  const count = nextClickCount(point, touchClickRadius());
  const modifiers = takeModifiers();
  send({ type: 'pointer_down', ...point, button: 'left', count, modifiers });
  send({ type: 'pointer_up', ...point, button: 'left', count, modifiers });
  spawnRipple(info.x, info.y);
}

function handleTouchUp(event) {
  const info = touches.get(event.pointerId);
  touches.delete(event.pointerId);
  event.preventDefault();
  cancelLongPress();
  clearDirectHold();
  hideTouchFeedback();

  if (panPointerId === event.pointerId) {
    panPointerId = null;
    twoFinger = null;
    return;
  }

  if (twoFinger) {
    const now = performance.now();
    // 双指快速轻点 → 右键
    if (!twoFinger.mode && now - twoFinger.startTime < TAP_MAX_MS) {
      const point = touchMode === 'direct' && info ? eventFromInfo(info) : cursor;
      send({ type: 'click', ...point, button: 'right', count: 1, modifiers: takeModifiers() });
      cursorPulse();
      notify('双指轻点 → 右键');
    }
    // 滚动手势松手时按释放速度启动惯性
    if (twoFinger.mode === 'scroll') maybeStartMomentum(twoFinger);
    // 另一根手指随后抬起时不再触发单击；其后续移动也整体忽略（防被当作全新单指手势）
    suppressTap = true;
    touches.forEach((t) => {
      t.inGesture = true;
    });
    if (touches.size < 2) twoFinger = null;
    return;
  }

  if (!info) return;
  const now = performance.now();
  const duration = now - info.startTime;

  if (touchDragging) {
    const point = touchMode === 'direct' ? eventFromInfo(info) : cursor;
    endRemoteDrag(point);
    dragArmed = false;
    dragReady = false;
    return;
  }
  dragArmed = false;

  // 直触模式：按住超过拖拽阈值但没移动也没触发右键 → 视为一次慢速点击
  if (touchMode === 'direct' && dragReady && !suppressTap) {
    dragReady = false;
    const point = eventFromInfo(info);
    setCursor(point);
    sendTapClick(point, info);
    return;
  }
  dragReady = false;

  const isTap = duration < TAP_MAX_MS && info.travel < TAP_MAX_TRAVEL && !suppressTap;
  if (!isTap) return;

  const point = touchMode === 'direct' ? eventFromInfo(info) : cursor;
  if (touchMode === 'direct') setCursor(point);
  sendTapClick(point, info);
}

function handleTouchCancel(event) {
  touches.delete(event.pointerId);
  cancelLongPress();
  clearDirectHold();
  hideTouchFeedback();
  twoFinger = null;
  panPointerId = null;
  dragArmed = false;
  dragReady = false;
  if (touchDragging) endRemoteDrag(cursor);
}

// ---------- 触控模式与拖拽锁定 ----------

function setTouchMode(mode, announce = true) {
  touchMode = mode;
  document.querySelectorAll('[data-touch-mode]').forEach((button) => {
    button.classList.toggle('active', button.dataset.touchMode === mode);
  });
  dockModeValue.textContent = mode === 'trackpad' ? '触控板' : '直触';
  positionRemoteCursor();
  if (announce) notify(mode === 'trackpad' ? '触控板模式：单指移动光标' : '直触模式：点哪按哪');
}

function setDragLock(locked, announce = true) {
  if (locked === dragLocked) return;
  dragLocked = locked;
  dockDragBtn.classList.toggle('active', locked);
  remoteCursor.classList.toggle('dragging', locked);
  if (locked) {
    send({ type: 'pointer_down', ...cursor, button: 'left', modifiers: takeModifiers() });
    if (announce) notify('拖拽锁定开启');
  } else {
    send({ type: 'pointer_up', ...cursor, button: 'left' });
    if (announce) notify('拖拽锁定关闭');
  }
  positionRemoteCursor();
}

// ---------- 平移模式 ----------

// 平移状态用显式变量与常驻提示条表达，避免用户困在“触摸全被平移吃掉”的状态里
function setPanMode(active, announce = true) {
  panMode = active;
  panBtn.classList.toggle('active', active);
  panExitChip.hidden = !active;
  stage.classList.toggle('pan-mode', active);
  if (!active) panPointerId = null;
  if (announce) notify(active ? '单指平移视图开启' : '单指平移视图关闭');
}

panExitChip.addEventListener('click', () => setPanMode(false));

// ---------- 键盘抽屉与 IME ----------

let imePrev = '';
let composing = false;

// visualViewport：iOS/Android 弹出系统键盘时只收缩可视视口，
// fixed 定位的抽屉会被键盘遮住——按遮挡高度把抽屉平移到键盘上方
function updateKbdLift() {
  const vv = window.visualViewport;
  if (!vv || kbdPanel.hidden) {
    kbdPanel.style.transform = '';
    return;
  }
  const occluded = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  // 抽屉静态位置已在 dock 上方，抬升量需扣除 dock 高度才能贴住系统键盘顶部
  const lift = Math.max(0, occluded - dock.offsetHeight);
  kbdPanel.style.transform = lift > 0 ? `translateY(${-lift}px)` : '';
}

function openKeyboard() {
  kbdPanel.hidden = false;
  dockKeyboardBtn.classList.add('active');
  imeInput.focus();
  updateKbdLift();
}

function closeKeyboard() {
  kbdPanel.hidden = true;
  kbdPanel.style.transform = '';
  dockKeyboardBtn.classList.remove('active');
  imeInput.blur();
}

// 抽屉精简模式：隐藏方向键/快捷键扩展行，给画面留出空间；状态持久化
function setKbdCompact(compact, persist = true) {
  kbdPanel.classList.toggle('compact', compact);
  kbdMoreBtn.textContent = compact ? '更多' : '精简';
  kbdMoreBtn.classList.toggle('active', !compact);
  if (persist) {
    try {
      localStorage.setItem('kbdCompact', compact ? '1' : '');
    } catch {
      // 无痕模式下写入失败可忽略
    }
  }
}

kbdMoreBtn.addEventListener('click', () => setKbdCompact(!kbdPanel.classList.contains('compact')));

// 输入框内容差分同步：比较公共前缀+公共后缀，只发送中间差异。
// 中间编辑时先 ←/退格 定位删除，再补文本，最后 → 归位，远端不再整段闪烁重打。
function syncImeInput() {
  const current = imeInput.value;
  if (current === imePrev) return;
  let prefix = 0;
  const max = Math.min(current.length, imePrev.length);
  while (prefix < max && current[prefix] === imePrev[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    current[current.length - 1 - suffix] === imePrev[imePrev.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = imePrev.length - prefix - suffix;
  const added = current.slice(prefix, current.length - suffix);
  // 连发键用 repeat 字段合并为单条消息（agent 端循环注入），删除/移位大段文本不再刷屏
  if (suffix) send({ type: 'key_press', key: 'arrowleft', modifiers: [], repeat: suffix });
  if (removed) send({ type: 'key_press', key: 'backspace', modifiers: [], repeat: removed });
  if (added) send({ type: 'type_text', text: added });
  if (suffix) send({ type: 'key_press', key: 'arrowright', modifiers: [], repeat: suffix });
  imePrev = current;
}

imeInput.addEventListener('compositionstart', () => {
  composing = true;
});
imeInput.addEventListener('compositionend', () => {
  composing = false;
  syncImeInput();
});
imeInput.addEventListener('input', () => {
  if (!composing) syncImeInput();
});
imeInput.addEventListener('keydown', (event) => {
  if (composing) return;
  if (event.key === 'Enter') {
    sendKey('enter', []);
    imeInput.value = '';
    imePrev = '';
    event.preventDefault();
    return;
  }
  if (event.key === 'Backspace' && imeInput.value === '') {
    sendKey('backspace', []);
    event.preventDefault();
    return;
  }
  // 有修饰键激活时，字母作为快捷键发送而非输入
  if (stickyModifiers.size && event.key.length === 1) {
    sendKey(event.key.toLowerCase());
    event.preventDefault();
  }
});

// 关键：按抽屉里的按钮不能让 imeInput 失焦，否则 iOS 系统键盘会收起再弹出、
// 整个页面跳动一次。捕获阶段阻止 mousedown 默认行为即可保持焦点（click 照常触发）。
kbdPanel.addEventListener(
  'mousedown',
  (event) => {
    if (event.target !== imeInput && event.target.closest('button')) {
      event.preventDefault();
    }
  },
  { capture: true },
);

kbdPanel.addEventListener('contextmenu', (event) => event.preventDefault());
dock.addEventListener('contextmenu', (event) => event.preventDefault());

document.querySelectorAll('[data-modifier]').forEach((button) => {
  button.addEventListener('click', () => {
    const name = button.dataset.modifier;
    if (stickyModifiers.has(name)) {
      stickyModifiers.delete(name);
      button.classList.remove('active');
    } else {
      stickyModifiers.add(name);
      button.classList.add('active');
    }
  });
});

// 常用键：pointerdown 立即发送；白名单键按住 400ms 后以 60ms/次连发（key repeat）
const REPEATABLE_KEYS = new Set(['Backspace', 'ForwardDelete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space']);

// 抽屉按键发送：⌫ 在 IME 输入框有内容时删本地暂存并走差分同步，
// 保持“远端内容 === imePrev”的基线不变量；其余情况直发远端
function pressDrawerKey(rawKeyName, key, mods) {
  if (rawKeyName === 'Backspace' && !mods.length && !kbdPanel.hidden && imeInput.value) {
    imeInput.value = imeInput.value.slice(0, -1);
    syncImeInput();
    return;
  }
  send({ type: 'key_press', key, modifiers: mods });
}

document.querySelectorAll('[data-key]').forEach((button) => {
  let holdTimer = null;
  let repeatTimer = null;
  const stopRepeat = () => {
    clearTimeout(holdTimer);
    clearInterval(repeatTimer);
    holdTimer = null;
    repeatTimer = null;
  };
  button.addEventListener('pointerdown', (event) => {
    // 阻止默认避免抢走 imeInput 焦点/触发长按选择
    event.preventDefault();
    stopRepeat();
    const rawKeyName = button.dataset.key;
    const key = rawKeyName.toLowerCase();
    const mods = currentModifiers();
    clearStickyModifiers();
    pressDrawerKey(rawKeyName, key, mods);
    if (!REPEATABLE_KEYS.has(rawKeyName)) return;
    holdTimer = setTimeout(() => {
      repeatTimer = setInterval(() => pressDrawerKey(rawKeyName, key, mods), 60);
    }, 400);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((name) => button.addEventListener(name, stopRepeat));
});

document.querySelectorAll('[data-shortcut]').forEach((button) => {
  button.addEventListener('click', () => {
    const parts = button.dataset.shortcut.split('+');
    const key = parts.pop();
    sendKey(key, parts);
  });
});

// ---------- 长文本发送（分片） ----------

// 服务端对单条 type_text 限长 2000（UTF-16 单元）。按码点分片逐条发送：
// 长文本不再截断丢失，也不会把 emoji 等代理对拆到两条消息里
const TEXT_CHUNK_CODEPOINTS = 1000;

// 返回实际发送的字符数（码点计）；无内容/未连接/控制停用时提示并返回 0
function sendTextInChunks(text) {
  if (!text) {
    notify('没有可发送的文本');
    return 0;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    notify('未连接，文本发送失败');
    return 0;
  }
  if (!controlEnabled.checked) {
    notify('远程控制已停用，文本未发送');
    return 0;
  }
  const codepoints = Array.from(text);
  for (let i = 0; i < codepoints.length; i += TEXT_CHUNK_CODEPOINTS) {
    send({ type: 'type_text', text: codepoints.slice(i, i + TEXT_CHUNK_CODEPOINTS).join('') });
  }
  return codepoints.length;
}

function sendBulkFrom(input) {
  const count = sendTextInChunks(input.value);
  if (count) notify(`已发送 ${count} 个字符`);
}

// ⌘/Ctrl+Enter 快速发送（textarea 内 Enter 保留换行语义）
function bindSendShortcut(textarea, sendAction) {
  textarea.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      sendAction();
    }
  });
}

sendBulkText.addEventListener('click', () => sendBulkFrom(bulkTextInput));
bindSendShortcut(bulkTextInput, () => sendBulkFrom(bulkTextInput));

clearBulkText.addEventListener('click', () => {
  bulkTextInput.value = '';
});

// ---------- 键盘抽屉长文本区（移动端长文本入口） ----------

function updateKbdBulkCount() {
  kbdBulkCount.textContent = `${Array.from(kbdBulkInput.value).length} 字`;
}

kbdBulkBtn.addEventListener('click', () => {
  const opening = kbdBulk.hidden;
  kbdBulk.hidden = !opening;
  kbdBulkBtn.classList.toggle('active', opening);
  // 焦点跟随切换目标，保持系统键盘不收起
  (opening ? kbdBulkInput : imeInput).focus();
});

kbdBulkInput.addEventListener('input', updateKbdBulkCount);
kbdBulkSend.addEventListener('click', () => sendBulkFrom(kbdBulkInput));
bindSendShortcut(kbdBulkInput, () => sendBulkFrom(kbdBulkInput));

kbdBulkClear.addEventListener('click', () => {
  kbdBulkInput.value = '';
  updateKbdBulkCount();
  kbdBulkInput.focus();
});

// ---------- 视图操作与全屏 ----------

async function toggleLandscapeView() {
  view.rotation = view.rotation === 0 ? 90 : 0;
  view.panX = 0;
  view.panY = 0;
  applyViewTransform();
  if (document.fullscreenElement && window.screen.orientation?.lock) {
    try {
      if (view.rotation === 90) await window.screen.orientation.lock('landscape');
      else window.screen.orientation.unlock?.();
    } catch {
      // 部分浏览器不支持方向锁定，视图旋转已生效即可
    }
  }
}

document.querySelectorAll('[data-view-action]').forEach((button) => {
  button.addEventListener('click', async () => {
    const action = button.dataset.viewAction;
    if (action === 'zoom-in') setZoom(view.zoom * 1.2);
    if (action === 'zoom-out') setZoom(view.zoom / 1.2);
    if (action === 'reset') resetView();
    if (action === 'landscape') await toggleLandscapeView();
    if (action === 'pan') setPanMode(!panMode);
  });
});

function setFullscreenUi(active) {
  document.body.classList.toggle('theater', active);
  fullscreenBtn.textContent = active ? '退出全屏' : '全屏';
  stageFullscreenBtn.textContent = active ? '退出全屏' : '全屏';
  fullscreenExitBtn.hidden = !active;
}

async function enterFullscreen() {
  setFullscreenUi(true);
  try {
    // 整页进入真全屏（而非仅 stage 元素）：Android 真全屏时只有全屏元素在 top layer，
    // 对 stage 全屏会让 dock 与键盘抽屉不可见、无法唤起键盘
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
    }
  } catch {
    // iOS Safari 不支持 requestFullscreen，仅使用页面沉浸布局
  }
}

async function exitFullscreen() {
  if (document.fullscreenElement) await document.exitFullscreen();
  window.screen.orientation?.unlock?.();
  setFullscreenUi(false);
}

function toggleFullscreen() {
  if (document.body.classList.contains('theater')) exitFullscreen();
  else enterFullscreen();
}

fullscreenBtn.addEventListener('click', toggleFullscreen);
stageFullscreenBtn.addEventListener('click', toggleFullscreen);
fullscreenExitBtn.addEventListener('click', exitFullscreen);
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && !document.body.classList.contains('theater')) return;
  setFullscreenUi(Boolean(document.fullscreenElement));
  updateDockHeight();
});

// ---------- 底部快捷栏 ----------

dockModeBtn.addEventListener('click', () => setTouchMode(touchMode === 'trackpad' ? 'direct' : 'trackpad'));
dockKeyboardBtn.addEventListener('click', () => (kbdPanel.hidden ? openKeyboard() : closeKeyboard()));
dockRightClickBtn.addEventListener('click', () => {
  send({ type: 'click', ...cursor, button: 'right', count: 1, modifiers: takeModifiers() });
  cursorPulse();
});
dockDragBtn.addEventListener('click', () => setDragLock(!dragLocked));
dockViewBtn.addEventListener('click', () => {
  stageTools.classList.toggle('open');
  dockViewBtn.classList.toggle('active');
});
kbdCloseBtn.addEventListener('click', closeKeyboard);

document.querySelectorAll('[data-touch-mode]').forEach((button) => {
  button.addEventListener('click', () => setTouchMode(button.dataset.touchMode));
});

// 键盘抽屉高度依赖 dock 实际高度（含安全区），测量后写入 CSS 变量
function updateDockHeight() {
  if (dock.offsetHeight) {
    document.documentElement.style.setProperty('--dock-h', `${dock.offsetHeight}px`);
  }
}

// ---------- 手势引导 ----------

function openGestureGuide() {
  gestureGuide.hidden = false;
}

function closeGestureGuide() {
  gestureGuide.hidden = true;
  try {
    localStorage.setItem('gestureGuideSeen', '1');
  } catch {
    // 无痕模式下写入失败可忽略，最坏情况是下次再显示
  }
}

gestureGuideClose.addEventListener('click', closeGestureGuide);
gestureGuide.addEventListener('click', (event) => {
  if (event.target === gestureGuide) closeGestureGuide();
});
gestureHelpBtn.addEventListener('click', openGestureGuide);

// ---------- 其它 UI ----------

copyLinkBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    notify('已复制控制台地址');
  } catch {
    log(window.location.href);
  }
});

async function runAuthAction(action) {
  const response = await fetch(`/api/permissions/guide?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '授权动作失败');
  updateStatus(payload);
  authModalStatus.textContent = permissionLabel.textContent;
}

function openAuthModal() {
  authModal.hidden = false;
  fetch(`/api/permissions/status?token=${encodeURIComponent(token)}`)
    .then((res) => res.json())
    .then((payload) => {
      updateStatus(payload);
      authModalStatus.textContent = permissionLabel.textContent;
    })
    .catch((error) => {
      authModalStatus.textContent = error.message;
    });
}

authGuideBtn.addEventListener('click', openAuthModal);
// 移动端 topbar-actions 隐藏，权限异常标签兼作授权引导入口
permissionLabel.addEventListener('click', openAuthModal);
authModalClose.addEventListener('click', () => {
  authModal.hidden = true;
});
authModal.addEventListener('click', (event) => {
  if (event.target === authModal) authModal.hidden = true;
});

document.querySelectorAll('[data-auth-action]').forEach((button) => {
  button.addEventListener('click', async () => {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = '处理中...';
    try {
      await runAuthAction(button.dataset.authAction);
    } catch (error) {
      authModalStatus.textContent = error.message;
      log(error.message);
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  });
});

reconnectNowBtn.addEventListener('click', () => {
  notify('正在重新连接');
  reconnectNow();
});

// ---------- 生命周期：释放按下状态 / 后台恢复 ----------

// 页面隐藏/离开时释放所有按下的鼠标状态，防止 Mac 端左键永久卡死。
// 走 sendRaw 绕过 controlEnabled 门控——释放消息属于安全消息，任何时候都应发出。
function releasePressedButtons() {
  const buttons = new Set();
  if (dragLocked) {
    dragLocked = false;
    dockDragBtn.classList.remove('active');
    buttons.add('left');
    log('已自动释放拖拽锁定');
  }
  if (touchDragging) {
    touchDragging = false;
    buttons.add('left');
  }
  if (desktopButtonDown) {
    buttons.add(desktopButtonDown);
    desktopButtonDown = null;
  }
  if (!buttons.size) return;
  remoteCursor.classList.remove('dragging');
  flushMove();
  for (const button of buttons) {
    sendRaw({ type: 'pointer_up', ...cursor, button });
  }
  positionRemoteCursor();
}

// 关闭“启用远程控制”前先释放按下状态，避免关闭后释放消息被门控丢弃
controlEnabled.addEventListener('change', () => {
  if (!controlEnabled.checked) releasePressedButtons();
});

function handleReturnToForeground() {
  keepAwake();
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    // 切后台期间连接已断：跳过退避立即重连
    reconnectNow();
  } else if (ws.readyState === WebSocket.OPEN) {
    // 连接看似存活也要探活，识别 iOS 回前台后的僵尸连接
    probeConnection();
  }
  requestAnimationFrame(positionRemoteCursor);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    cancelMomentum();
    releasePressedButtons();
    return;
  }
  handleReturnToForeground();
});

// iOS 从 bfcache 恢复时不触发 visibilitychange，用 pageshow 兜底
window.addEventListener('pageshow', (event) => {
  if (event.persisted) handleReturnToForeground();
});

window.addEventListener('online', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) reconnectNow();
});

// iOS Safari 基本不触发 beforeunload，pagehide 才是移动端可靠的离开事件
window.addEventListener('pagehide', () => {
  releasePressedButtons();
  ws?.close();
});

window.addEventListener('beforeunload', () => {
  releasePressedButtons();
  ws?.close();
});

// 惯性滚动期间任何按下（画面/dock 等）立即截停；同时记录“本次触摸是为截停惯性”，
// 供 handleTouchDown 吞掉截停轻点（截停不应产生点击）。此捕获监听先于 canvas 处理器执行。
document.addEventListener(
  'pointerdown',
  () => {
    momentumStoppedByTouch = momentum !== null;
    cancelMomentum();
  },
  { capture: true },
);

// 用户手势时启动屏幕保活：挂在 pointerup（触屏 pointerdown 不授予 user activation，
// 视频 play 会被拒），成功后再移除监听，失败则下一次手势自动重试
const keepAwakeOnGesture = async () => {
  await keepAwake();
  if (wakeLockSentinel || (keepAwakeVideo && !keepAwakeVideo.paused)) {
    document.removeEventListener('pointerup', keepAwakeOnGesture);
  }
};
document.addEventListener('pointerup', keepAwakeOnGesture);

// ---------- 布局变化：光标重定位 / dock 高度 ----------

window.addEventListener('resize', () => {
  positionRemoteCursor();
  updateDockHeight();
});

// 旋转屏幕后布局稳定时机不确定（旋转动画+地址栏收展），双重延迟重定位
function repositionAfterRotate() {
  requestAnimationFrame(positionRemoteCursor);
  setTimeout(() => {
    positionRemoteCursor();
    updateDockHeight();
    updateKbdLift();
  }, 350);
}

try {
  window.screen.orientation?.addEventListener?.('change', repositionAfterRotate);
} catch {
  // 老浏览器无 screen.orientation
}
window.addEventListener('orientationchange', repositionAfterRotate);

if (window.visualViewport) {
  const onViewportShift = () => {
    requestAnimationFrame(() => {
      updateKbdLift();
      positionRemoteCursor();
    });
  };
  window.visualViewport.addEventListener('resize', onViewportShift);
  window.visualViewport.addEventListener('scroll', onViewportShift);
}

// ---------- 启动 ----------

setTouchMode(isCoarsePointer ? 'trackpad' : 'direct', false);
applyViewTransform();
updateDockHeight();

// 键盘抽屉精简状态恢复
try {
  setKbdCompact(localStorage.getItem('kbdCompact') === '1', false);
} catch {
  setKbdCompact(false, false);
}

// 移动端首次访问显示手势引导
if (isCoarsePointer) {
  try {
    if (!localStorage.getItem('gestureGuideSeen')) openGestureGuide();
  } catch {
    // localStorage 不可用时跳过引导
  }
}

connect();
