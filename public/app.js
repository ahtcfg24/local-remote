// app.js — 远程控制前端
//
// 分区：网络层 / 视图变换与坐标映射 / 桌面输入 / 触屏输入（触控板+直触）/ 键盘抽屉 / UI 绑定
// 移动端要点：轻点零延迟（clickState 计数）、惯性滚动、拖拽/长按可视反馈、
//   visualViewport 键盘抬升、屏幕保活、后台恢复秒重连、toast 操作反馈。

import { RemoteConnection, accessTokenFrom } from './connection.js';
import { TextSender } from './text-sender.js';
import { remotePlatform, shortcutForPlatform } from './platform.js';

// ---------- DOM 引用 ----------

const tokenFromUrl = accessTokenFrom(window.location.href, { allowBare: false });
let storedToken = '';
try {
  storedToken = sessionStorage.getItem('localRemoteToken') || '';
  if (tokenFromUrl) sessionStorage.setItem('localRemoteToken', tokenFromUrl);
} catch {
  // 某些隐私模式禁用 sessionStorage，当前页面仍可正常使用 URL 中的 token。
}
let token = tokenFromUrl || storedToken;
if (tokenFromUrl && window.history?.replaceState) {
  // 避免访问密钥长期停留在浏览器历史、截图和地址栏中。
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete('token');
  const fragment = new URLSearchParams(cleanUrl.hash.slice(1));
  fragment.delete('token');
  cleanUrl.hash = fragment.toString();
  window.history.replaceState(null, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
}
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
const accessForm = $('accessForm');
const accessInput = $('accessInput');
const accessChangeBtn = $('accessChangeBtn');
const streamHelpBtn = $('streamHelpBtn');
const controlToggleBtn = $('controlToggleBtn');
const controlStateLabel = $('controlStateLabel');
const imeHint = $('imeHint');

// ---------- 全局状态 ----------

// 触屏设备判定：pointer: coarse 之外用 maxTouchPoints 兜底——
// 部分浏览器（桌面视口模式/魔改内核）不上报 coarse，但触控交互仍应按移动端处理
const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;

let connection;
let latestStatus = null;
let connectionState = 'connecting';
let hasFrame = false;
let frameGeneration = 0;
let latestStatusError = '';
let lastInputError = '';
let accessUrls = [];
let textSender;
let targetPlatform = remotePlatform();
let lastSubmittedText = '';
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
  showToast(message);
}

function setConnection(state, label, detail = '') {
  connectionState = state;
  connectionDot.dataset.state = state;
  connectionLabel.textContent = label;
  connOverlay.hidden = state === 'open';
  connOverlayText.textContent = detail || label;
  accessForm.hidden = state !== 'auth';
  reconnectNowBtn.hidden = state === 'auth';
  accessChangeBtn.hidden = state === 'auth';
  if (state === 'open') {
    log('已连接');
    if (!isCoarsePointer && authModal.hidden && gestureGuide.hidden) canvas.focus();
  }
  refreshControlState();
}

function inputBlockReason() {
  if (!connection?.isOpen) return '尚未连接，操作未发送';
  if (!controlEnabled.checked) return '当前仅查看，点击「恢复控制」后操作';
  if (latestStatus?.agent && latestStatus.agent.state !== 'ready') return '远程控制服务正在恢复，请稍后操作';
  if (latestStatus?.permissions?.accessibility !== 'ok') return targetPlatform.windows
    ? 'Windows 输入服务不可用，请确认桌面已登录且未锁定' : 'Mac 尚未授予辅助功能权限';
  if (latestStatus?.capturing === false || !hasFrame) return '等待当前屏幕画面后再操作';
  return '';
}

function refreshControlState() {
  const reason = inputBlockReason();
  controlToggleBtn.textContent = controlEnabled.checked ? '暂停控制' : '恢复控制';
  $('stageControlBtn').textContent = controlToggleBtn.textContent;
  controlToggleBtn.classList.toggle('active', !controlEnabled.checked);
  controlToggleBtn.setAttribute('aria-pressed', String(!controlEnabled.checked));
  controlStateLabel.textContent = reason || (latestStatus?.control?.busy ? '其他设备可能正在拖拽，结束后即可操作' : '可控制 · 点击画面后使用实体键盘');
  canvas.setAttribute('aria-label', reason ? `远程屏幕：${reason}` : '远程屏幕，可控制');
  dockRightClickBtn.disabled = Boolean(reason);
  dockDragBtn.disabled = Boolean(reason) && !dragLocked;
  sendBulkText.disabled = Boolean(reason) || bulkTextInput.dataset.sending === 'true';
  kbdBulkSend.disabled = Boolean(reason) || kbdBulkInput.dataset.sending === 'true';
}

function updateStreamState() {
  if (connectionState !== 'open') return;
  let message = '';
  if (latestStatus?.agent && latestStatus.agent.state !== 'ready') message = '远程控制服务正在恢复…';
  else if (latestStatus?.permissions?.screenRecording !== 'ok') message = targetPlatform.windows
    ? 'Windows 屏幕采集不可用，请确认桌面已登录且未锁定' : '请在 Mac 上允许 Local Remote Agent 录制屏幕';
  else if (latestStatus?.capturing === false) message = latestStatus?.errors?.capture || '屏幕采集暂不可用，正在恢复…';
  else if (!hasFrame) message = '已连接，等待第一帧屏幕画面…';
  emptyState.textContent = message;
  emptyState.hidden = !message;
  screenWrap.classList.toggle('stream-unavailable', Boolean(message));
  streamHelpBtn.hidden = !message || latestStatus?.permissions?.screenRecording === 'ok';
  refreshControlState();
}

// ---------- 网络层 ----------

let frameCount = 0;
let byteCount = 0;
let decoding = false;
let pendingFrame = null;

async function drawFrame(buffer, generation = frameGeneration) {
  // 解码期间只保留最新一帧，防止慢设备上积压导致延迟
  if (decoding) {
    pendingFrame = { buffer, generation };
    return;
  }
  decoding = true;
  try {
    const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/jpeg' }));
    if (generation !== frameGeneration || !connection?.isOpen) {
      bitmap.close?.();
      return;
    }
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    hasFrame = true;
    ctx.drawImage(bitmap, 0, 0);
    updateStreamState();
    bitmap.close?.();
  } catch (error) {
    log(`绘制屏幕帧失败：${error.message}`);
  } finally {
    decoding = false;
    if (pendingFrame) {
      const next = pendingFrame;
      pendingFrame = null;
      drawFrame(next.buffer, next.generation);
    }
  }
}

function updatePlatform(payload) {
  targetPlatform = remotePlatform(payload.platform);
  const windows = targetPlatform.windows;
  $('platformHint').textContent = `连接到你的 ${targetPlatform.name} · 仅限可信局域网`;
  $('authModalTitle').textContent = windows ? 'Windows 连接状态' : 'macOS 授权引导';
  $('macAuthSteps').hidden = windows;
  $('windowsAuthSteps').hidden = !windows;
  $('openGuideBtn').hidden = windows;
  authGuideBtn.textContent = windows ? '连接检查' : '授权引导';
  streamHelpBtn.textContent = windows ? '检查连接状态' : '打开授权引导';
  $('accessHelp').textContent = windows
    ? '在 Windows 上运行 .\\start.ps1 status 可查看连接地址。'
    : '在 Mac 上运行 ./start.sh status 可查看连接地址。';
  const labels = windows ? { command: 'Win', control: 'Ctrl', option: 'Alt', shift: 'Shift' }
    : { command: '⌘', control: '⌃', option: '⌥', shift: '⇧' };
  document.querySelectorAll('[data-modifier]').forEach((button) => {
    button.textContent = labels[button.dataset.modifier];
  });
  document.querySelectorAll('[data-shortcut]').forEach((button) => {
    button.dataset.macShortcut ||= button.dataset.shortcut;
    button.dataset.macLabel ||= button.textContent;
    const mapped = shortcutForPlatform(button.dataset.macShortcut, button.dataset.macLabel, payload.platform);
    button.dataset.shortcut = mapped.shortcut;
    button.textContent = mapped.label;
  });
  if (textSender) textSender.timeoutMs = windows ? 15000 : 6000;
}

function updateStatus(payload) {
  updatePlatform(payload);
  const geometryChanged = payload.screen?.width && payload.screen?.height
    && (payload.screen.width !== screenSize.width || payload.screen.height !== screenSize.height);
  if (geometryChanged || payload.capturing === false || (payload.agent && payload.agent.state !== 'ready')) {
    hasFrame = false;
    pendingFrame = null;
    frameGeneration += 1;
  }
  latestStatus = payload;
  if (Array.isArray(payload.accessUrls)) accessUrls = payload.accessUrls;
  if (payload.screen?.width && payload.screen?.height) {
    screenSize = payload.screen;
    if (!cursorInitialized || cursor.x >= screenSize.width || cursor.y >= screenSize.height) {
      cursor = { x: screenSize.width / 2, y: screenSize.height / 2 };
      cursorInitialized = true;
    }
    screenWrap.style.setProperty('--screen-ratio', String(screenSize.width / screenSize.height));
    positionRemoteCursor();
  }

  const screenOk = payload.permissions?.screenRecording === 'ok';
  const accessOk = payload.permissions?.accessibility === 'ok';
  const perms = [];
  perms.push(screenOk ? '录屏✓' : targetPlatform.windows ? '采集不可用' : '录屏待授权');
  perms.push(accessOk ? '控制✓' : targetPlatform.windows ? '输入不可用' : '辅助功能待授权');
  if (payload.capturing === false && screenOk) perms.push('采集重连中');
  permissionLabel.textContent = perms.join(' · ');
  // 移动端顶栏空间宝贵：权限全部正常时隐藏标签，异常时高亮显示并可点击打开授权引导
  permissionLabel.hidden = isCoarsePointer && screenOk && accessOk && payload.capturing !== false;
  permissionLabel.classList.toggle('perm-warn', !(screenOk && accessOk));

  const errors = [payload.errors?.capture, payload.errors?.agent].filter(Boolean);
  const errorText = errors.join('\n');
  if (errorText && errorText !== latestStatusError) log(errorText);
  latestStatusError = errorText;
  if (inputBlockReason()) resetInteractions();
  updateStreamState();
}

function connect() { return connection.connect(); }
function reconnectNow() { return connection.reconnect(token); }
function probeConnection() { connection.probe(); }

// Releases bypass the viewing switch; all other input requires a usable frame.
function sendRaw(payload) { return connection?.send(payload) || false; }
function send(payload) {
  if (inputBlockReason()) return false;
  return sendRaw(payload);
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
  statsLabel.textContent = connectionState !== 'open' ? '—' : isCoarsePointer
    ? `${frameCount}fps`
    : `${screenSize.width}×${screenSize.height} · ${frameCount}fps · ${mb.toFixed(1)}MB/s`;
  frameCount = 0;
  byteCount = 0;
}, 1000);

// ---------- 屏幕保活 ----------

// Screen Wake Lock is best effort. Insecure LAN origins often lack this API;
// avoid hidden media fallbacks and retry only after returning to the foreground.
let wakeLockSentinel = null;
let wakeLockPending = null;
let wakeLockFailureLogged = false;

async function keepAwake() {
  if (document.visibilityState === 'hidden' || wakeLockSentinel) return;
  if (wakeLockPending) return wakeLockPending;
  if (!navigator.wakeLock?.request) {
    if (!wakeLockFailureLogged) log('当前浏览器不支持屏幕常亮');
    wakeLockFailureLogged = true;
    return;
  }
  wakeLockPending = (async () => {
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel = sentinel;
      sentinel.addEventListener('release', () => {
        if (wakeLockSentinel === sentinel) wakeLockSentinel = null;
      });
    } catch (error) {
      if (!wakeLockFailureLogged) log(`屏幕常亮申请未获允许：${error.message}`);
      wakeLockFailureLogged = true;
    }
  })();
  try { await wakeLockPending; } finally { wakeLockPending = null; }
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
let desktopPan = null;

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
  if (inputBlockReason() && !panMode) {
    notify(inputBlockReason());
    return;
  }
  if (event.pointerType === 'touch') {
    handleTouchDown(event);
    return;
  }
  if (event.button > 2 || desktopButtonDown) return;
  screenWrap.setPointerCapture?.(event.pointerId);
  if (panMode && event.button === 0) {
    desktopPan = { x: event.clientX, y: event.clientY };
    event.preventDefault();
    return;
  }
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
  if (desktopPan) {
    view.panX += event.clientX - desktopPan.x;
    view.panY += event.clientY - desktopPan.y;
    desktopPan = { x: event.clientX, y: event.clientY };
    applyViewTransform();
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
  if (desktopPan) { desktopPan = null; event.preventDefault(); return; }
  if (desktopButtonDown && mouseButtonNames[event.button] !== desktopButtonDown) return;
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
  resetInteractions();
});

screenWrap.addEventListener('lostpointercapture', (event) => {
  if (touches.has(event.pointerId) || desktopButtonDown || desktopPan) resetInteractions();
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
      if (event.target !== canvas || inputBlockReason()) return;
      const point = eventToScreenPoint(event);
      setCursor(point);
      flushMove();
      send({ type: 'pointer_move', ...point });
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? screenSize.height : 1;
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
  if (event.isComposing || event.keyCode === 229 || inputBlockReason()) return;
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
  if (!send({ type: 'pointer_down', ...point, button: 'left', modifiers: takeModifiers() })) return;
  touchDragging = true;
  remoteCursor.classList.add('dragging');
  navigator.vibrate?.(10);
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
    // A second finger ends a held mouse button before scrolling or pinching.
    if (touchDragging) endRemoteDrag(cursor);
    if (dragLocked) setDragLock(false, false);
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

  if (dragLocked) {
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

  if (!info || dragLocked) return;
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
  if (announce) resetInteractions();
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
  if (locked && inputBlockReason()) { notify(inputBlockReason()); return; }
  dragLocked = locked;
  dockDragBtn.classList.toggle('active', locked);
  remoteCursor.classList.toggle('dragging', locked);
  if (locked) {
    send({ type: 'pointer_down', ...cursor, button: 'left', modifiers: takeModifiers() });
    if (announce) notify('拖拽锁定开启');
  } else {
    flushMove();
    sendRaw({ type: 'pointer_up', ...cursor, button: 'left' });
    if (announce) notify('拖拽锁定关闭');
  }
  positionRemoteCursor();
}

// ---------- 平移模式 ----------

// 平移状态用显式变量与常驻提示条表达，避免用户困在“触摸全被平移吃掉”的状态里
function setPanMode(active, announce = true) {
  resetInteractions();
  panMode = active;
  panBtn.classList.toggle('active', active);
  panExitChip.hidden = !active;
  stage.classList.toggle('pan-mode', active);
  if (!active) panPointerId = null;
  if (announce) notify(active ? '单指平移视图开启' : '单指平移视图关闭');
}

panExitChip.addEventListener('click', () => setPanMode(false));

// ---------- 键盘抽屉与 IME ----------

let composing = false;
let imePending = null;
let imeNeedsExplicitSend = false;

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
  keyRepeatStops.forEach((stop) => stop());
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

// A committed composition is appended once, then the local field is cleared.
// Keeping a mirror of a remote editor is unsafe: the Mac caret can move without
// our knowledge, so local edits must never generate inferred remote deletions.
async function syncImeInput(force = false) {
  if (composing) return;
  if (imePending) {
    if (!imePending.accepted) return;
    const submitted = imePending.text;
    imePending = null;
    if (imeInput.value.startsWith(submitted)) imeInput.value = imeInput.value.slice(submitted.length);
    else {
      imeNeedsExplicitSend = true;
      imeHint.textContent = '已发送的文字随后被本地编辑。请检查远程电脑；输入框内容保留，按回车可另行发送。';
      return;
    }
  }
  if (imeNeedsExplicitSend && !force) return;
  const current = imeInput.value;
  if (!current) return;
  const reason = inputBlockReason();
  if (reason) {
    imeNeedsExplicitSend = true;
    imeHint.textContent = `${reason}。文字保留在输入框，恢复后可按回车发送。`;
    return;
  }
  imeNeedsExplicitSend = false;
  const pending = { text: current, accepted: false };
  imePending = pending;
  try {
    await sendText(current);
    if (imePending !== pending) return;
    pending.accepted = true;
    imeHint.textContent = '已提交到远程输入服务；可恢复上次文本。需要修改的文字请先在「长文」中编辑。';
    if (!composing) syncImeInput();
  } catch (error) {
    if (imePending === pending) imePending = null;
    imeNeedsExplicitSend = true;
    imeHint.textContent = `${error.message}。文字已保留，请检查远程电脑 后再按回车重试。`;
  }
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
  if (composing || event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter') {
    if (imeInput.value) syncImeInput(true);
    else sendKey('enter', []);
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

imeInput.addEventListener('beforeinput', (event) => {
  if (!composing && event.inputType === 'deleteContentBackward' && !imeInput.value) {
    event.preventDefault();
    sendKey('backspace', []);
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

// Local unsent text remains local; drawer navigation never derives edits in
// a remote application from an old input-buffer baseline.
const keyRepeatStops = new Set();
function pressDrawerKey(rawKeyName, key, mods) {
  if (rawKeyName === 'Backspace' && !mods.length && imeInput.value) {
    const chars = Array.from(imeInput.value);
    chars.pop();
    imeInput.value = chars.join('');
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
  keyRepeatStops.add(stopRepeat);
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
  ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture'].forEach((name) => button.addEventListener(name, stopRepeat));
  button.addEventListener('click', (event) => {
    // Keyboard and assistive-technology activation has no pointerdown.
    if (event.detail === 0) pressDrawerKey(button.dataset.key, button.dataset.key.toLowerCase(), takeModifiers());
  });
});

document.querySelectorAll('[data-shortcut]').forEach((button) => {
  button.addEventListener('click', () => {
    const parts = button.dataset.shortcut.split('+');
    const key = parts.pop();
    sendKey(key, parts);
  });
});

// ---------- 文本发送：服务端逐条确认，不自动重放 ----------

function sendText(text) {
  const reason = inputBlockReason();
  if (reason) return Promise.reject(new Error(reason));
  return textSender.send(text).then(() => {
    lastSubmittedText = text;
    document.querySelectorAll('[data-restore-text]').forEach((button) => { button.disabled = false; });
  });
}

function settleTextRequest(payload) { textSender.settle(payload); }

async function sendBulkFrom(input) {
  if (input.dataset.sending === 'true') return;
  input.dataset.sending = 'true';
  const text = input.value;
  const button = input === bulkTextInput ? sendBulkText : kbdBulkSend;
  const originalLabel = button.textContent;
  button.textContent = '发送中…';
  refreshControlState();
  try {
    await sendText(text);
    notify(`已提交 ${Array.from(text).length} 个字符到远程输入服务`);
  } catch (error) {
    notify(`${error.message}；原文已保留`);
  } finally {
    delete input.dataset.sending;
    button.textContent = originalLabel;
    refreshControlState();
  }
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

document.querySelectorAll('[data-restore-text]').forEach((button) => {
  button.addEventListener('click', () => {
    if (!lastSubmittedText) return;
    if (button.dataset.restoreText === 'desktop') {
      bulkTextInput.value = lastSubmittedText;
      bulkTextInput.focus();
    } else {
      kbdBulk.hidden = false;
      kbdBulkBtn.classList.add('active');
      kbdBulkInput.value = lastSubmittedText;
      updateKbdBulkCount();
      kbdBulkInput.focus();
    }
    notify('已恢复上次文本到编辑框；检查远程电脑后可手动发送');
  });
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
$('desktopKeyboardBtn').addEventListener('click', () => (kbdPanel.hidden ? openKeyboard() : closeKeyboard()));
$('stageKeyboardBtn').addEventListener('click', () => (kbdPanel.hidden ? openKeyboard() : closeKeyboard()));
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

function openGestureGuide() { showModal(gestureGuide, gestureGuideClose); }

function closeGestureGuide() {
  hideModal(gestureGuide);
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

async function copyAccessLink() {
  if (!token) { notify('请先输入连接密钥'); return; }
  const lanUrl = accessUrls.find((value) => {
    try { return !['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname); } catch { return false; }
  });
  const shareUrl = new URL(window.location.protocol === 'https:' ? window.location.href : lanUrl || window.location.href);
  shareUrl.searchParams.delete('token');
  shareUrl.hash = new URLSearchParams({ token }).toString();
  const link = shareUrl.toString();
  try {
    await navigator.clipboard.writeText(link);
    notify('已复制连接地址；持有地址的人可控制这台电脑');
  } catch {
    // HTTP LAN origins often have no Clipboard API. Offer selectable text in
    // a deliberate sharing dialog instead of leaking the credential into logs.
    $('shareLinkInput').value = link;
    showModal($('shareModal'), $('shareLinkInput'));
    $('shareLinkInput').select();
  }
}
copyLinkBtn.addEventListener('click', copyAccessLink);
$('stageCopyLinkBtn').addEventListener('click', copyAccessLink);
$('shareModalClose').addEventListener('click', () => hideModal($('shareModal')));

accessChangeBtn.addEventListener('click', () => {
  connection.stop();
  connection.authFailed = true;
  setConnection('auth', '更换连接密钥', '粘贴远程电脑提供的连接地址或密钥。');
  accessInput.focus();
});
accessForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const nextToken = accessTokenFrom(accessInput.value);
  if (!nextToken) {
    connOverlayText.textContent = '未找到连接密钥，请粘贴完整连接地址或密钥。';
    return;
  }
  token = nextToken;
  accessInput.value = '';
  try { sessionStorage.setItem('localRemoteToken', token); } catch {}
  connection.authFailed = false;
  reconnectNow();
});

let modalOpener = null;
function showModal(modal, focusTarget) {
  resetInteractions();
  modalOpener = document.activeElement;
  modal.hidden = false;
  focusTarget?.focus();
}
function hideModal(modal) {
  modal.hidden = true;
  modalOpener?.focus?.();
  modalOpener = null;
}
document.addEventListener('keydown', (event) => {
  const modal = Array.from(document.querySelectorAll('.modal-backdrop')).find((el) => !el.hidden);
  if (!modal) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (modal === gestureGuide) closeGestureGuide();
    else hideModal(modal);
  } else if (event.key === 'Tab') {
    const focusable = Array.from(modal.querySelectorAll('button:not(:disabled), input, textarea, [tabindex="0"]')).filter((el) => el.getClientRects().length);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});

async function readResponse(response) {
  if (response.status === 401 || response.status === 403) throw new Error('连接密钥无效，请更换连接密钥');
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

function authHeaders(extra = {}) {
  return { ...extra, Authorization: `Bearer ${token}` };
}

async function runAuthAction(action) {
  const response = await fetch('/api/permissions/guide', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ action }),
  });
  const payload = await readResponse(response);
  updateStatus(payload);
  authModalStatus.textContent = permissionLabel.textContent;
}

function openAuthModal() {
  showModal(authModal, authModalClose);
  authModalStatus.textContent = '正在检测权限…';
  fetch('/api/permissions/status', { headers: authHeaders() })
    .then(readResponse)
    .then((payload) => {
      updateStatus(payload);
      authModalStatus.textContent = permissionLabel.textContent;
    })
    .catch((error) => {
      authModalStatus.textContent = error.message;
    });
}

authGuideBtn.addEventListener('click', openAuthModal);
streamHelpBtn.addEventListener('click', openAuthModal);
// 移动端 topbar-actions 隐藏，权限异常标签兼作授权引导入口
permissionLabel.addEventListener('click', openAuthModal);
authModalClose.addEventListener('click', () => {
  hideModal(authModal);
});
authModal.addEventListener('click', (event) => {
  if (event.target === authModal) hideModal(authModal);
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
  const held = dragLocked || touchDragging || desktopButtonDown;
  dragLocked = false;
  touchDragging = false;
  desktopButtonDown = null;
  desktopPan = null;
  dockDragBtn.classList.remove('active');
  remoteCursor.classList.remove('dragging');
  if (held) sendRaw({ type: 'release_inputs' });
  positionRemoteCursor();
}

function resetInteractions() {
  cancelMomentum();
  clearTimeout(moveTimer);
  moveTimer = null;
  pendingMove = null;
  cancelLongPress();
  clearDirectHold();
  hideTouchFeedback();
  keyRepeatStops.forEach((stop) => stop());
  touches.clear();
  twoFinger = null;
  panPointerId = null;
  dragArmed = false;
  dragReady = false;
  suppressTap = true;
  clickTrack = { time: 0, x: 0, y: 0, count: 0 };
  clearStickyModifiers();
  releasePressedButtons();
}

function changeControlEnabled() {
  if (!controlEnabled.checked) resetInteractions();
  refreshControlState();
}
controlEnabled.addEventListener('change', changeControlEnabled);
function toggleControl() {
  controlEnabled.checked = !controlEnabled.checked;
  changeControlEnabled();
  notify(controlEnabled.checked ? '远程控制已恢复' : '已暂停控制，可继续查看画面');
}
controlToggleBtn.addEventListener('click', toggleControl);
$('stageControlBtn').addEventListener('click', toggleControl);

function handleReturnToForeground() {
  if (connection.authFailed) return;
  keepAwake();
  if (!connection.isOpen) reconnectNow();
  else probeConnection();
  requestAnimationFrame(positionRemoteCursor);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { resetInteractions(); return; }
  handleReturnToForeground();
});
window.addEventListener('blur', resetInteractions);
window.addEventListener('pageshow', (event) => {
  if (event.persisted) handleReturnToForeground();
});
window.addEventListener('online', () => {
  if (!connection.isOpen && !connection.authFailed) reconnectNow();
});
window.addEventListener('offline', () => {
  connection.stop();
  setConnection('closed', '网络已断开', '请连接到远程电脑所在的局域网，网络恢复后会自动重连。');
});
window.addEventListener('pagehide', () => connection.stop());
window.addEventListener('beforeunload', () => connection.stop());

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

// Make one initial request, then rely on foreground recovery instead of
// repeatedly asking after every tap when the browser does not support it.
document.addEventListener('pointerup', keepAwake, { once: true });

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

textSender = new TextSender({ send });
connection = new RemoteConnection({
  token,
  onState: setConnection,
  onStatus: updateStatus,
  onFrame(buffer) {
    frameCount += 1;
    byteCount += buffer.byteLength;
    drawFrame(buffer);
  },
  onInputResult: settleTextRequest,
  onError(payload) {
    settleTextRequest(payload);
    resetInteractions();
    const message = payload.message || '操作未完成，请稍后重试';
    if (message !== lastInputError) notify(message);
    lastInputError = message;
    setTimeout(() => { if (lastInputError === message) lastInputError = ''; }, 2000);
  },
  onReset() {
    textSender.reset();
    resetInteractions();
    frameGeneration += 1;
    pendingFrame = null;
    hasFrame = false;
    latestStatus = null;
    screenWrap.classList.add('stream-unavailable');
    frameCount = 0;
    byteCount = 0;
  },
});
connect();
