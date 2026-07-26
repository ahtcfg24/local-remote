// app.js — 远程控制前端
//
// 分区：网络层 / 视图变换与坐标映射 / 桌面输入 / 触屏输入（触控板+直触）/ 键盘抽屉 / UI 绑定

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
const fullscreenExitBtn = $('fullscreenExitBtn');
const copyLinkBtn = $('copyLinkBtn');
const dockModeBtn = $('dockModeBtn');
const dockKeyboardBtn = $('dockKeyboardBtn');
const dockRightClickBtn = $('dockRightClickBtn');
const dockDragBtn = $('dockDragBtn');
const dockViewBtn = $('dockViewBtn');
const kbdPanel = $('kbdPanel');
const kbdCloseBtn = $('kbdCloseBtn');
const imeInput = $('imeInput');
const bulkTextInput = $('bulkTextInput');
const sendBulkText = $('sendBulkText');
const clearBulkText = $('clearBulkText');
const authModal = $('authModal');
const authGuideBtn = $('authGuideBtn');
const authModalClose = $('authModalClose');
const authModalStatus = $('authModalStatus');

// ---------- 全局状态 ----------

const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let screenSize = { width: canvas.width, height: canvas.height };
let cursor = { x: 640, y: 360 };
let cursorInitialized = false;
let touchMode = 'trackpad';
let dragLocked = false;
let view = { zoom: 1, rotation: 0, panX: 0, panY: 0 };
const stickyModifiers = new Set();

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;
const TAP_MAX_MS = 300;
const TAP_MAX_TRAVEL = 12;
const DOUBLE_TAP_MS = 280;
const LONG_PRESS_MS = 500;
const DIRECT_DRAG_HOLD_MS = 300;

// ---------- 日志与状态显示 ----------

function log(message) {
  const time = new Date().toLocaleTimeString();
  logOutput.textContent = `[${time}] ${message}\n` + logOutput.textContent.split('\n').slice(0, 10).join('\n');
}

function setConnection(state, label) {
  connectionDot.dataset.state = state;
  connectionLabel.textContent = label;
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

  const perms = [];
  perms.push(payload.permissions?.screenRecording === 'ok' ? '录屏✓' : '录屏待授权');
  perms.push(payload.permissions?.accessibility === 'ok' ? '控制✓' : '辅助功能待授权');
  if (payload.capturing === false && payload.permissions?.screenRecording === 'ok') perms.push('采集重连中');
  permissionLabel.textContent = perms.join(' · ');

  const errors = [payload.errors?.capture, payload.errors?.agent].filter(Boolean);
  if (errors.length) log(errors.join('\n'));
}

function connect() {
  clearTimeout(reconnectTimer);
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.binaryType = 'arraybuffer';
  setConnection('connecting', '连接中');

  ws.addEventListener('open', () => {
    setConnection('open', '已连接');
    reconnectDelay = 1000;
    log('已连接');
    if (!isCoarsePointer) canvas.focus();
  });

  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'status') updateStatus(payload);
      } catch {
        log(event.data);
      }
      return;
    }
    frameCount += 1;
    byteCount += event.data.byteLength;
    drawFrame(event.data);
  });

  ws.addEventListener('close', () => {
    setConnection('closed', '已断开');
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(5000, reconnectDelay + 1000);
  });

  ws.addEventListener('error', () => setConnection('closed', '连接错误'));
}

function send(payload) {
  if (!controlEnabled.checked) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
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

// 每秒刷新帧率/带宽统计
setInterval(() => {
  const mb = byteCount / (1024 * 1024);
  statsLabel.textContent = `${screenSize.width}×${screenSize.height} · ${frameCount}fps · ${mb.toFixed(1)}MB/s`;
  frameCount = 0;
  byteCount = 0;
}, 1000);

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
  remoteCursor.hidden = !(isCoarsePointer && touchMode === 'trackpad');
}

function moveCursorBy(dx, dy) {
  cursor = {
    x: clamp(cursor.x + dx, 0, screenSize.width - 1),
    y: clamp(cursor.y + dy, 0, screenSize.height - 1),
  };
  positionRemoteCursor();
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

function sendKey(key, modifiers = null) {
  const mods = modifiers ?? currentModifiers();
  send({ type: 'key_press', key, modifiers: mods });
  if (!modifiers) clearStickyModifiers();
}

// ---------- 点击计数（让远程端识别真双击）----------

let clickTrack = { time: 0, x: 0, y: 0, count: 0 };

function nextClickCount(point) {
  const now = performance.now();
  const near = Math.hypot(point.x - clickTrack.x, point.y - clickTrack.y) < 8;
  clickTrack = {
    time: now,
    x: point.x,
    y: point.y,
    count: now - clickTrack.time < 400 && near ? Math.min(3, clickTrack.count + 1) : 1,
  };
  return clickTrack.count;
}

// ---------- 桌面端鼠标/键盘输入 ----------

const mouseButtonNames = ['left', 'middle', 'right'];
let desktopButtonDown = null;

canvas.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'touch') {
    handleTouchDown(event);
    return;
  }
  canvas.setPointerCapture?.(event.pointerId);
  canvas.focus();
  const point = eventToScreenPoint(event);
  setCursor(point);
  const button = mouseButtonNames[event.button] || 'left';
  desktopButtonDown = button;
  send({ type: 'pointer_down', ...point, button, count: nextClickCount(point) });
  event.preventDefault();
});

canvas.addEventListener('pointermove', (event) => {
  if (event.pointerType === 'touch') {
    handleTouchMove(event);
    return;
  }
  const point = eventToScreenPoint(event);
  setCursor(point);
  if (desktopButtonDown) {
    sendPointerMove('pointer_drag', point, desktopButtonDown);
  } else {
    sendPointerMove('pointer_move', point);
  }
});

canvas.addEventListener('pointerup', (event) => {
  if (event.pointerType === 'touch') {
    handleTouchUp(event);
    return;
  }
  const point = eventToScreenPoint(event);
  setCursor(point);
  if (desktopButtonDown) {
    flushMove();
    send({ type: 'pointer_up', ...point, button: desktopButtonDown, count: clickTrack.count });
    desktopButtonDown = null;
  }
  event.preventDefault();
});

canvas.addEventListener('pointercancel', (event) => {
  if (event.pointerType === 'touch') {
    handleTouchCancel(event);
    return;
  }
  if (desktopButtonDown) {
    send({ type: 'pointer_up', ...cursor, button: desktopButtonDown });
    desktopButtonDown = null;
  }
});

canvas.addEventListener('contextmenu', (event) => event.preventDefault());

canvas.addEventListener(
  'wheel',
  (event) => {
    // Ctrl/⌘ + 滚轮缩放本地视图，其余透传远程滚动
    if (event.ctrlKey || event.metaKey) {
      const rect = canvas.getBoundingClientRect();
      const origin = {
        x: event.clientX - (rect.left + rect.width / 2),
        y: event.clientY - (rect.top + rect.height / 2),
      };
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
let pendingTap = null;
let touchDragging = false;
let dragArmed = false;
let directHoldTimer = null;
let twoFinger = null;
let panPointerId = null;
const TRACKPAD_BASE_SENSITIVITY = 1.1;

function cancelLongPress() {
  clearTimeout(longPressTimer);
  longPressTimer = null;
}

function trackpadAcceleration(dx, dy, dtMs) {
  // 根据滑动速度调节灵敏度：慢速精确、快速跨屏
  const speed = Math.hypot(dx, dy) / Math.max(1, dtMs);
  const factor = clamp(0.9 + speed * 2.4, 0.9, 3.6);
  return TRACKPAD_BASE_SENSITIVITY * factor;
}

function beginRemoteDrag(point) {
  touchDragging = true;
  send({ type: 'pointer_down', ...point, button: 'left' });
}

function endRemoteDrag(point) {
  if (!touchDragging) return;
  touchDragging = false;
  flushMove();
  send({ type: 'pointer_up', ...point, button: 'left' });
}

function handleTouchDown(event) {
  canvas.setPointerCapture?.(event.pointerId);
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

  if (panBtn.classList.contains('active') && touches.size === 1) {
    panPointerId = event.pointerId;
    return;
  }

  if (touches.size === 2) {
    // 进入双指手势：取消单指的一切待定行为
    cancelLongPress();
    clearTimeout(directHoldTimer);
    if (pendingTap) {
      clearTimeout(pendingTap.timer);
      pendingTap = null;
    }
    const points = Array.from(touches.values());
    twoFinger = {
      mode: null,
      startTime: now,
      startDistance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) || 1,
      lastMid: { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 },
      startMid: { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 },
      startZoom: view.zoom,
      startPanX: view.panX,
      startPanY: view.panY,
    };
    return;
  }
  if (touches.size > 2) {
    twoFinger = null;
    return;
  }

  suppressTap = false;

  // 快速二次按下：取消待发的单击；随后移动则为拖拽，快速抬起则为双击
  if (pendingTap) {
    clearTimeout(pendingTap.timer);
    pendingTap = null;
    dragArmed = true;
  }

  if (touchMode === 'direct') {
    const point = eventToScreenPoint(event);
    setCursor(point);
    // 按住不动一段时间进入拖拽
    directHoldTimer = setTimeout(() => {
      const info = touches.get(event.pointerId);
      if (info && info.travel < TAP_MAX_TRAVEL && touches.size === 1 && !touchDragging) {
        suppressTap = true;
        beginRemoteDrag(eventFromInfo(info));
      }
    }, DIRECT_DRAG_HOLD_MS);
  }

  // 长按（未移动）→ 右键
  longPressTimer = setTimeout(() => {
    const info = touches.get(event.pointerId);
    if (info && info.travel < TAP_MAX_TRAVEL && touches.size === 1 && !touchDragging) {
      suppressTap = true;
      const point = touchMode === 'direct' ? eventFromInfo(info) : cursor;
      send({ type: 'click', ...point, button: 'right', count: 1 });
      navigator.vibrate?.(20);
      log('长按 → 右键');
    }
  }, LONG_PRESS_MS);
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
  info.travel += Math.abs(dx) + Math.abs(dy);
  info.lastTime = now;
  event.preventDefault();

  if (info.travel > TAP_MAX_TRAVEL) cancelLongPress();

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
    if (dragArmed && !touchDragging && info.travel > 4) {
      // 双击-按住-移动：从当前光标位置开始拖拽
      beginRemoteDrag(cursor);
    }
    const accel = trackpadAcceleration(dx, dy, dt);
    // 视图旋转 90° 时，手指位移也旋转映射，保证方向直觉一致
    const rotated = rotateDelta(dx * accel, dy * accel);
    moveCursorBy(rotated.dx, rotated.dy);
    sendPointerMove(touchDragging || dragLocked ? 'pointer_drag' : 'pointer_move', cursor);
    return;
  }

  // 直触模式：移动即移动光标（悬停），拖拽状态下发送拖拽
  const point = eventToScreenPoint(event);
  setCursor(point);
  if (touchDragging || dragLocked) {
    sendPointerMove('pointer_drag', point);
  } else if (info.travel > TAP_MAX_TRAVEL) {
    clearTimeout(directHoldTimer);
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

  // 手势判定：先看距离变化（捏合缩放），再看整体位移（滚动），锁定后不再切换
  if (!twoFinger.mode) {
    const distanceChange = Math.abs(distance - twoFinger.startDistance);
    const midTravel = Math.hypot(mid.x - twoFinger.startMid.x, mid.y - twoFinger.startMid.y);
    if (distanceChange > 30) twoFinger.mode = 'pinch';
    else if (midTravel > 10) twoFinger.mode = 'scroll';
  }

  if (twoFinger.mode === 'pinch') {
    const wrapRect = screenWrap.getBoundingClientRect();
    const origin = {
      x: mid.x - (wrapRect.left + wrapRect.width / 2),
      y: mid.y - (wrapRect.top + wrapRect.height / 2),
    };
    setZoom(twoFinger.startZoom * (distance / twoFinger.startDistance), origin);
  } else if (twoFinger.mode === 'scroll') {
    const rotated = rotateDelta(mid.x - twoFinger.lastMid.x, mid.y - twoFinger.lastMid.y);
    // 内容跟随手指的自然滚动方向
    send({ type: 'wheel', dx: -rotated.dx * 2.4, dy: -rotated.dy * 2.4 });
  }
  twoFinger.lastMid = mid;
}

function handleTouchUp(event) {
  const info = touches.get(event.pointerId);
  touches.delete(event.pointerId);
  event.preventDefault();
  cancelLongPress();
  clearTimeout(directHoldTimer);

  if (panPointerId === event.pointerId) {
    panPointerId = null;
    return;
  }

  if (twoFinger) {
    // 双指快速轻点 → 右键
    const now = performance.now();
    if (!twoFinger.mode && now - twoFinger.startTime < TAP_MAX_MS) {
      const point = touchMode === 'direct' && info ? eventFromInfo(info) : cursor;
      send({ type: 'click', ...point, button: 'right', count: 1 });
      log('双指轻点 → 右键');
    }
    // 另一根手指随后抬起时不再触发单击
    suppressTap = true;
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
    return;
  }
  dragArmed = false;

  const isTap = duration < TAP_MAX_MS && info.travel < TAP_MAX_TRAVEL && !suppressTap;
  if (!isTap) {
    dragArmed = false;
    return;
  }

  const point = touchMode === 'direct' ? eventFromInfo(info) : cursor;
  if (touchMode === 'direct') setCursor(point);

  // 延迟单击以区分双击：双击时合并为一次 count=2 的真双击
  if (dragArmed) {
    dragArmed = false;
    send({ type: 'click', ...point, button: 'left', count: 2 });
  } else {
    pendingTap = {
      timer: setTimeout(() => {
        pendingTap = null;
        send({ type: 'click', ...point, button: 'left', count: 1 });
      }, DOUBLE_TAP_MS),
    };
  }
}

function handleTouchCancel(event) {
  touches.delete(event.pointerId);
  cancelLongPress();
  clearTimeout(directHoldTimer);
  twoFinger = null;
  panPointerId = null;
  dragArmed = false;
  if (touchDragging) endRemoteDrag(cursor);
}

// ---------- 触控模式与拖拽锁定 ----------

function setTouchMode(mode, announce = true) {
  touchMode = mode;
  document.querySelectorAll('[data-touch-mode]').forEach((button) => {
    button.classList.toggle('active', button.dataset.touchMode === mode);
  });
  dockModeBtn.textContent = mode === 'trackpad' ? '触控板' : '直触';
  positionRemoteCursor();
  if (announce) log(mode === 'trackpad' ? '触控板模式' : '直接触摸模式');
}

function setDragLock(locked) {
  if (locked === dragLocked) return;
  dragLocked = locked;
  dockDragBtn.classList.toggle('active', locked);
  if (locked) {
    send({ type: 'pointer_down', ...cursor, button: 'left' });
    log('拖拽锁定开启');
  } else {
    send({ type: 'pointer_up', ...cursor, button: 'left' });
    log('拖拽锁定关闭');
  }
}

// ---------- 键盘抽屉与 IME ----------

let imePrev = '';
let composing = false;

function openKeyboard() {
  kbdPanel.hidden = false;
  dockKeyboardBtn.classList.add('active');
  imeInput.focus();
}

function closeKeyboard() {
  kbdPanel.hidden = true;
  dockKeyboardBtn.classList.remove('active');
  imeInput.blur();
}

// 输入框内容差分同步：删除的部分发退格，新增的部分发文本（IME 组合完成后一次性发送）
function syncImeInput() {
  const current = imeInput.value;
  if (current === imePrev) return;
  let prefix = 0;
  const max = Math.min(current.length, imePrev.length);
  while (prefix < max && current[prefix] === imePrev[prefix]) prefix += 1;
  const removed = imePrev.length - prefix;
  const added = current.slice(prefix);
  for (let i = 0; i < Math.min(removed, 100); i += 1) {
    send({ type: 'key_press', key: 'backspace', modifiers: [] });
  }
  if (added) send({ type: 'type_text', text: added });
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
    imeInput.focus();
  });
});

document.querySelectorAll('[data-key]').forEach((button) => {
  button.addEventListener('click', () => {
    sendKey(button.dataset.key.toLowerCase());
    if (!kbdPanel.hidden) imeInput.focus();
  });
});

document.querySelectorAll('[data-shortcut]').forEach((button) => {
  button.addEventListener('click', () => {
    const parts = button.dataset.shortcut.split('+');
    const key = parts.pop();
    sendKey(key, parts);
    if (!kbdPanel.hidden) imeInput.focus();
  });
});

sendBulkText.addEventListener('click', () => {
  const text = bulkTextInput.value;
  if (!text) return;
  send({ type: 'type_text', text });
  log(`已发送 ${text.length} 个字符`);
});

clearBulkText.addEventListener('click', () => {
  bulkTextInput.value = '';
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
    if (action === 'pan') {
      panBtn.classList.toggle('active');
      log(panBtn.classList.contains('active') ? '单指平移视图开启' : '单指平移视图关闭');
    }
  });
});

function setFullscreenUi(active) {
  document.body.classList.toggle('theater', active);
  fullscreenBtn.textContent = active ? '退出全屏' : '全屏';
  fullscreenExitBtn.hidden = !active;
}

async function enterFullscreen() {
  setFullscreenUi(true);
  try {
    if (!document.fullscreenElement && stage.requestFullscreen) {
      await stage.requestFullscreen();
    }
  } catch {
    // iOS Safari 不支持元素全屏，仅使用页面沉浸布局
  }
}

async function exitFullscreen() {
  if (document.fullscreenElement) await document.exitFullscreen();
  window.screen.orientation?.unlock?.();
  setFullscreenUi(false);
}

fullscreenBtn.addEventListener('click', () => {
  if (document.body.classList.contains('theater')) exitFullscreen();
  else enterFullscreen();
});
fullscreenExitBtn.addEventListener('click', exitFullscreen);
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && !document.body.classList.contains('theater')) return;
  setFullscreenUi(Boolean(document.fullscreenElement));
});

// ---------- 底部快捷栏 ----------

dockModeBtn.addEventListener('click', () => setTouchMode(touchMode === 'trackpad' ? 'direct' : 'trackpad'));
dockKeyboardBtn.addEventListener('click', () => (kbdPanel.hidden ? openKeyboard() : closeKeyboard()));
dockRightClickBtn.addEventListener('click', () => send({ type: 'click', ...cursor, button: 'right', count: 1 }));
dockDragBtn.addEventListener('click', () => setDragLock(!dragLocked));
dockViewBtn.addEventListener('click', () => {
  stageTools.classList.toggle('open');
  dockViewBtn.classList.toggle('active');
});
kbdCloseBtn.addEventListener('click', closeKeyboard);

document.querySelectorAll('[data-touch-mode]').forEach((button) => {
  button.addEventListener('click', () => setTouchMode(button.dataset.touchMode));
});

// ---------- 其它 UI ----------

copyLinkBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    log('已复制控制台地址');
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

authGuideBtn.addEventListener('click', () => {
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
});
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

window.addEventListener('beforeunload', () => {
  if (dragLocked || touchDragging || desktopButtonDown) {
    send({ type: 'pointer_up', ...cursor, button: 'left' });
  }
  ws?.close();
});

window.addEventListener('resize', positionRemoteCursor);

// ---------- 启动 ----------

setTouchMode(isCoarsePointer ? 'trackpad' : 'direct', false);
applyViewTransform();
connect();
