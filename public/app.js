const token = new URLSearchParams(window.location.search).get('token') || '';
const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const emptyState = document.getElementById('emptyState');
const connectionDot = document.getElementById('connectionDot');
const connectionLabel = document.getElementById('connectionLabel');
const screenLabel = document.getElementById('screenLabel');
const permissionLabel = document.getElementById('permissionLabel');
const logOutput = document.getElementById('logOutput');
const controlEnabled = document.getElementById('controlEnabled');
const textInput = document.getElementById('textInput');
const sendText = document.getElementById('sendText');
const clearText = document.getElementById('clearText');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const fullscreenExitBtn = document.getElementById('fullscreenExitBtn');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const clickBtn = document.getElementById('clickBtn');
const doubleClickBtn = document.getElementById('doubleClickBtn');
const dragLock = document.getElementById('dragLock');
const pointerLabel = document.getElementById('pointerLabel');
const screenWrap = document.querySelector('.screen-wrap');
const appShell = document.querySelector('.app-shell');
const panMode = document.getElementById('panMode');
const zoomReadouts = document.querySelectorAll('.zoom-readout');
const remoteCursor = document.getElementById('remoteCursor');
const mobileModeBtn = document.getElementById('mobileModeBtn');

let ws = null;
let screen = { width: canvas.width, height: canvas.height };
let lastMoveAt = 0;
let reconnectTimer = null;
let selectedMouseButton = 'left';
let lastPointer = { x: 0, y: 0 };
let dragLocked = false;
let longPressTimer = null;
let longPressFired = false;
let remotePointerDown = false;
let activeMouseButton = 'left';
let view = {
  zoom: 1,
  rotation: 0,
  panX: 0,
  panY: 0,
};
let panPointerId = null;
let pinchState = null;
let touchMode = window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 900 ? 'trackpad' : 'direct';
let trackpadPointerId = null;
let trackpadLastPoint = null;
let trackpadTravel = 0;
let touchDownAt = 0;
let tapCount = 0;
let tapTimer = null;
let pointerInitialized = false;
const activePointers = new Map();

const pointerMoveInterval = window.matchMedia('(pointer: coarse)').matches ? 70 : 35;
const minZoom = 0.5;
const maxZoom = 4;
const trackpadSensitivity = 1.45;

function log(message) {
  const time = new Date().toLocaleTimeString();
  logOutput.textContent = `[${time}] ${message}\n` + logOutput.textContent.split('\n').slice(0, 8).join('\n');
}

function setConnection(state, label) {
  connectionDot.dataset.state = state;
  connectionLabel.textContent = label;
}

function send(payload) {
  if (!controlEnabled.checked) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function sendPointer(type, point = lastPointer, button = selectedMouseButton) {
  send({ type, ...point, button });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function applyViewTransform() {
  canvas.style.setProperty('--view-zoom', view.zoom);
  canvas.style.setProperty('--view-rotation', `${view.rotation}deg`);
  canvas.style.setProperty('--view-pan-x', `${view.panX}px`);
  canvas.style.setProperty('--view-pan-y', `${view.panY}px`);
  screenWrap.classList.toggle('is-rotated', view.rotation !== 0);
  zoomReadouts.forEach((item) => {
    item.textContent = `${Math.round(view.zoom * 100)}%`;
  });
  document.querySelectorAll('[data-view-action="landscape"]').forEach((button) => {
    button.classList.toggle('active', view.rotation !== 0);
    button.textContent = view.rotation === 0 ? '横屏' : '原向';
  });
  document.querySelectorAll('[data-view-action="pan"]').forEach((button) => {
    button.classList.toggle('active', Boolean(panMode?.checked));
  });
  positionRemoteCursor();
}

function setZoom(nextZoom, origin = null) {
  const previousZoom = view.zoom;
  view.zoom = clamp(nextZoom, minZoom, maxZoom);
  if (origin && previousZoom !== view.zoom) {
    view.panX = origin.x - (origin.x - view.panX) * (view.zoom / previousZoom);
    view.panY = origin.y - (origin.y - view.panY) * (view.zoom / previousZoom);
  }
  applyViewTransform();
}

function resetView() {
  view = { zoom: 1, rotation: 0, panX: 0, panY: 0 };
  if (panMode) panMode.checked = false;
  applyViewTransform();
  log('视图已重置');
}

function rotatePointForScreen(localX, localY, rect) {
  const normalizedRotation = ((view.rotation % 360) + 360) % 360;
  if (normalizedRotation === 90) {
    return {
      x: (localY / rect.height) * screen.width,
      y: (1 - localX / rect.width) * screen.height,
    };
  }
  if (normalizedRotation === 270) {
    return {
      x: (1 - localY / rect.height) * screen.width,
      y: (localX / rect.width) * screen.height,
    };
  }
  if (normalizedRotation === 180) {
    return {
      x: (1 - localX / rect.width) * screen.width,
      y: (1 - localY / rect.height) * screen.height,
    };
  }
  return {
    x: (localX / rect.width) * screen.width,
    y: (localY / rect.height) * screen.height,
  };
}

function screenPointToClient(point) {
  const rect = canvas.getBoundingClientRect();
  const normalizedRotation = ((view.rotation % 360) + 360) % 360;
  let localX;
  let localY;
  if (normalizedRotation === 90) {
    localX = (1 - point.y / screen.height) * rect.width;
    localY = (point.x / screen.width) * rect.height;
  } else if (normalizedRotation === 270) {
    localX = (point.y / screen.height) * rect.width;
    localY = (1 - point.x / screen.width) * rect.height;
  } else if (normalizedRotation === 180) {
    localX = (1 - point.x / screen.width) * rect.width;
    localY = (1 - point.y / screen.height) * rect.height;
  } else {
    localX = (point.x / screen.width) * rect.width;
    localY = (point.y / screen.height) * rect.height;
  }
  return { x: rect.left + localX, y: rect.top + localY };
}

function positionRemoteCursor() {
  if (!remoteCursor) return;
  const wrapRect = screenWrap.getBoundingClientRect();
  const client = screenPointToClient(lastPointer);
  remoteCursor.style.left = `${client.x - wrapRect.left}px`;
  remoteCursor.style.top = `${client.y - wrapRect.top}px`;
  remoteCursor.hidden = touchMode !== 'trackpad';
}

function setTouchMode(mode, announce = true) {
  touchMode = mode;
  document.querySelectorAll('[data-touch-mode]').forEach((button) => {
    button.classList.toggle('active', button.dataset.touchMode === touchMode);
  });
  if (mobileModeBtn) mobileModeBtn.textContent = touchMode === 'trackpad' ? '触控板' : '直触';
  positionRemoteCursor();
  if (announce) log(touchMode === 'trackpad' ? '触控板模式已开启' : '直接触摸模式已开启');
}

function mouseButtonLabel(button) {
  return button === 'left' ? '左键' : button === 'right' ? '右键' : '中键';
}

function setSelectedMouseButton(button) {
  selectedMouseButton = button;
  document.querySelectorAll('[data-mouse-button]').forEach((item) => {
    item.classList.toggle('active', item.dataset.mouseButton === selectedMouseButton);
  });
  log(`鼠标按键：${mouseButtonLabel(button)}`);
}

function setDragLock(checked) {
  if (checked === dragLocked) return;
  dragLocked = checked;
  dragLock.checked = checked;
  if (dragLocked) {
    activeMouseButton = selectedMouseButton;
    sendPointer('pointer_down');
    remotePointerDown = true;
    log('拖拽锁定已开启');
    return;
  }
  if (remotePointerDown) {
    sendPointer('pointer_up');
    remotePointerDown = false;
  }
  log('拖拽锁定已关闭');
}

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  const mapped = rotatePointForScreen(event.clientX - rect.left, event.clientY - rect.top, rect);
  return {
    x: clamp(mapped.x, 0, screen.width - 1),
    y: clamp(mapped.y, 0, screen.height - 1),
  };
}

function updatePointer(point) {
  lastPointer = point;
  pointerLabel.textContent = `指针：${Math.round(point.x)}, ${Math.round(point.y)} · ${mouseButtonLabel(selectedMouseButton)}`;
  positionRemoteCursor();
}

function updateStatus(payload) {
  if (payload.screen?.width && payload.screen?.height) {
    screen = payload.screen;
    if (!pointerInitialized) {
      lastPointer = { x: screen.width / 2, y: screen.height / 2 };
      pointerInitialized = true;
    }
    canvas.width = screen.width;
    canvas.height = screen.height;
    canvas.style.setProperty('--screen-aspect', `${screen.width} / ${screen.height}`);
    canvas.style.setProperty('--screen-ratio', screen.width / screen.height);
    screenLabel.textContent = `${screen.width} × ${screen.height} · ${payload.fps || '--'} FPS`;
    positionRemoteCursor();
  }

  const screenRecording = payload.permissions?.screenRecording;
  const accessibility = payload.permissions?.accessibility;
  const permissionParts = [];
  permissionParts.push(screenRecording === 'ok' ? '录屏已就绪' : '录屏待授权');
  permissionParts.push(accessibility === 'ok' ? '控制已就绪' : '辅助功能待授权');
  permissionLabel.textContent = permissionParts.join(' · ');

  const errors = [payload.errors?.frame, payload.errors?.control].filter(Boolean);
  if (errors.length) log(errors.join('\n'));
}

async function drawFrame(blob) {
  const bitmap = await createImageBitmap(blob);
  emptyState.hidden = true;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
}

function connect() {
  clearTimeout(reconnectTimer);
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.binaryType = 'blob';
  setConnection('connecting', '连接中');

  ws.addEventListener('open', () => {
    setConnection('open', '已连接');
    log('WebSocket 已连接');
    canvas.focus();
  });

  ws.addEventListener('message', async (event) => {
    if (typeof event.data === 'string') {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'status') updateStatus(payload);
      } catch {
        log(event.data);
      }
      return;
    }
    try {
      await drawFrame(event.data);
    } catch (error) {
      log(`绘制屏幕帧失败：${error.message}`);
    }
  });

  ws.addEventListener('close', () => {
    setConnection('closed', '已断开');
    log('连接断开，2 秒后重试');
    reconnectTimer = setTimeout(connect, 2000);
  });

  ws.addEventListener('error', () => {
    setConnection('closed', '连接错误');
  });
}

function pointerSnapshot(event) {
  return { x: event.clientX, y: event.clientY };
}

function pointerDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointerMidpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function startPinch() {
  const points = Array.from(activePointers.values());
  if (points.length < 2) return;
  pinchState = {
    distance: pointerDistance(points[0], points[1]) || 1,
    midpoint: pointerMidpoint(points[0], points[1]),
    zoom: view.zoom,
    panX: view.panX,
    panY: view.panY,
  };
}

function updatePinch() {
  if (!pinchState || activePointers.size < 2) return;
  const points = Array.from(activePointers.values());
  const distance = pointerDistance(points[0], points[1]) || 1;
  const midpoint = pointerMidpoint(points[0], points[1]);
  view.zoom = clamp(pinchState.zoom * (distance / pinchState.distance), minZoom, maxZoom);
  view.panX = pinchState.panX + midpoint.x - pinchState.midpoint.x;
  view.panY = pinchState.panY + midpoint.y - pinchState.midpoint.y;
  applyViewTransform();
}

canvas.addEventListener('pointermove', (event) => {
  const previous = activePointers.get(event.pointerId);
  if (previous) activePointers.set(event.pointerId, pointerSnapshot(event));

  if (activePointers.size >= 2) {
    updatePinch();
    event.preventDefault();
    return;
  }

  if (panPointerId === event.pointerId && previous) {
    view.panX += event.clientX - previous.x;
    view.panY += event.clientY - previous.y;
    applyViewTransform();
    event.preventDefault();
    return;
  }

  if (event.pointerType === 'touch' && touchMode === 'trackpad' && trackpadPointerId === event.pointerId && trackpadLastPoint) {
    const dx = (event.clientX - trackpadLastPoint.x) * trackpadSensitivity;
    const dy = (event.clientY - trackpadLastPoint.y) * trackpadSensitivity;
    trackpadLastPoint = pointerSnapshot(event);
    trackpadTravel += Math.abs(dx) + Math.abs(dy);
    if (Math.abs(dx) + Math.abs(dy) > 0.5) {
      updatePointer({
        x: clamp(lastPointer.x + dx, 0, screen.width - 1),
        y: clamp(lastPointer.y + dy, 0, screen.height - 1),
      });
      sendPointer(remotePointerDown ? 'pointer_drag' : 'pointer_move', lastPointer, activeMouseButton);
    }
    event.preventDefault();
    return;
  }

  const now = performance.now();
  if (now - lastMoveAt < pointerMoveInterval) return;
  lastMoveAt = now;
  const point = canvasPoint(event);
  updatePointer(point);
  if (event.pointerType === 'touch' && !dragLocked) {
    event.preventDefault();
    return;
  }
  sendPointer(dragLocked || remotePointerDown ? 'pointer_drag' : 'pointer_move', point, activeMouseButton);
});

canvas.addEventListener('pointerdown', (event) => {
  canvas.setPointerCapture?.(event.pointerId);
  canvas.focus();
  activePointers.set(event.pointerId, pointerSnapshot(event));
  clearTimeout(longPressTimer);
  longPressFired = false;

  if (activePointers.size >= 2) {
    startPinch();
    event.preventDefault();
    return;
  }

  if (panMode?.checked) {
    panPointerId = event.pointerId;
    event.preventDefault();
    return;
  }

  if (event.pointerType === 'touch' && touchMode === 'trackpad' && !dragLocked) {
    trackpadPointerId = event.pointerId;
    trackpadLastPoint = pointerSnapshot(event);
    trackpadTravel = 0;
    touchDownAt = performance.now();
    longPressTimer = setTimeout(() => {
      longPressFired = true;
      sendPointer('click', lastPointer, 'right');
      log('长按已发送右键单击');
    }, 650);
    event.preventDefault();
    return;
  }

  const point = canvasPoint(event);
  updatePointer(point);

  if (event.pointerType === 'touch' && !dragLocked) {
    longPressTimer = setTimeout(() => {
      longPressFired = true;
      sendPointer('click', point, 'right');
      log('长按已发送右键单击');
    }, 650);
    event.preventDefault();
    return;
  }

  if (!dragLocked) {
    const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : selectedMouseButton;
    activeMouseButton = button;
    sendPointer('pointer_down', point, button);
    remotePointerDown = true;
  }
  event.preventDefault();
});

canvas.addEventListener('pointerup', (event) => {
  const wasPinching = activePointers.size >= 2;
  activePointers.delete(event.pointerId);
  if (wasPinching) {
    pinchState = activePointers.size >= 2 ? pinchState : null;
    event.preventDefault();
    return;
  }

  if (panPointerId === event.pointerId) {
    panPointerId = null;
    event.preventDefault();
    return;
  }

  if (event.pointerType === 'touch' && touchMode === 'trackpad' && trackpadPointerId === event.pointerId) {
    clearTimeout(longPressTimer);
    trackpadPointerId = null;
    trackpadLastPoint = null;
    const isTap = performance.now() - touchDownAt < 420 && trackpadTravel < 12;
    if (isTap && !longPressFired) {
      tapCount += 1;
      clearTimeout(tapTimer);
      tapTimer = setTimeout(() => {
        if (tapCount >= 2) {
          sendPointer('double_click', lastPointer, selectedMouseButton);
          log('触控板双击');
        } else {
          sendPointer('click', lastPointer, selectedMouseButton);
          log('触控板单击');
        }
        tapCount = 0;
      }, 220);
    }
    longPressFired = false;
    trackpadTravel = 0;
    event.preventDefault();
    return;
  }

  const point = canvasPoint(event);
  updatePointer(point);
  clearTimeout(longPressTimer);
  if (event.pointerType === 'touch' && !dragLocked) {
    if (!longPressFired) sendPointer('click', point, selectedMouseButton);
    longPressFired = false;
    event.preventDefault();
    return;
  }

  if (!dragLocked && remotePointerDown) {
    const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : selectedMouseButton;
    sendPointer('pointer_up', point, button);
    remotePointerDown = false;
    activeMouseButton = selectedMouseButton;
  }
  event.preventDefault();
});

canvas.addEventListener('pointercancel', () => {
  clearTimeout(longPressTimer);
  activePointers.clear();
  panPointerId = null;
  pinchState = null;
  if (!dragLocked && remotePointerDown) {
    sendPointer('pointer_up', lastPointer, activeMouseButton);
    remotePointerDown = false;
    activeMouseButton = selectedMouseButton;
  }
});

canvas.addEventListener('contextmenu', (event) => {
  event.preventDefault();
});

canvas.addEventListener(
  'wheel',
  (event) => {
    if (event.ctrlKey || event.metaKey) {
      const rect = canvas.getBoundingClientRect();
      const origin = {
        x: event.clientX - (rect.left + rect.width / 2),
        y: event.clientY - (rect.top + rect.height / 2),
      };
      setZoom(view.zoom * (event.deltaY < 0 ? 1.12 : 0.88), origin);
      event.preventDefault();
      return;
    }
    send({ type: 'wheel', dx: event.deltaX, dy: event.deltaY });
    event.preventDefault();
  },
  { passive: false },
);

document.querySelectorAll('[data-mouse-button]').forEach((button) => {
  button.addEventListener('click', () => {
    setSelectedMouseButton(button.dataset.mouseButton);
    canvas.focus();
  });
});

document.querySelectorAll('[data-touch-mode]').forEach((button) => {
  button.addEventListener('click', () => {
    setTouchMode(button.dataset.touchMode);
    canvas.focus();
  });
});

clickBtn.addEventListener('click', () => {
  sendPointer('click');
  canvas.focus();
});

doubleClickBtn.addEventListener('click', () => {
  sendPointer('double_click');
  canvas.focus();
});

dragLock.addEventListener('change', () => {
  setDragLock(dragLock.checked);
  canvas.focus();
});

document.querySelectorAll('[data-scroll]').forEach((button) => {
  button.addEventListener('click', () => {
    const direction = button.dataset.scroll;
    const amount = 320;
    const delta = {
      up: { dx: 0, dy: -amount },
      down: { dx: 0, dy: amount },
      left: { dx: -amount, dy: 0 },
      right: { dx: amount, dy: 0 },
    }[direction];
    send({ type: 'wheel', ...delta });
    canvas.focus();
  });
});

async function toggleLandscapeView() {
  const nextRotation = view.rotation === 0 ? 90 : 0;
  view.rotation = nextRotation;
  view.panX = 0;
  view.panY = 0;
  applyViewTransform();

  if ((document.fullscreenElement || appShell.classList.contains('theater-mode')) && window.screen.orientation?.lock) {
    try {
      if (nextRotation === 90) {
        await window.screen.orientation.lock('landscape');
      } else {
        window.screen.orientation.unlock?.();
      }
    } catch (error) {
      log(`横屏锁定不可用，已使用视图旋转：${error.message}`);
    }
  }
}

document.querySelectorAll('[data-view-action]').forEach((button) => {
  button.addEventListener('click', async () => {
    const action = button.dataset.viewAction;
    if (action === 'zoom-in') setZoom(view.zoom * 1.18);
    if (action === 'zoom-out') setZoom(view.zoom / 1.18);
    if (action === 'reset') resetView();
    if (action === 'landscape') await toggleLandscapeView();
    if (action === 'pan' && panMode) {
      panMode.checked = !panMode.checked;
      log(panMode.checked ? '平移视图已开启' : '平移视图已关闭');
    }
    canvas.focus();
  });
});

document.querySelectorAll('[data-mobile-action]').forEach((button) => {
  button.addEventListener('click', () => {
    const action = button.dataset.mobileAction;
    if (action === 'mode') setTouchMode(touchMode === 'trackpad' ? 'direct' : 'trackpad');
    if (action === 'left-click') sendPointer('click', lastPointer, 'left');
    if (action === 'right-click') sendPointer('click', lastPointer, 'right');
    if (action === 'keyboard') {
      textInput.focus();
      return;
    }
    if (action === 'zoom-in') setZoom(view.zoom * 1.18);
    if (action === 'zoom-out') setZoom(view.zoom / 1.18);
    canvas.focus();
  });
});

panMode?.addEventListener('change', () => {
  applyViewTransform();
  log(panMode.checked ? '平移视图已开启' : '平移视图已关闭');
  canvas.focus();
});

function setFullscreenUi(active) {
  appShell.classList.toggle('theater-mode', active);
  screenWrap.classList.toggle('is-fullscreen', active);
  fullscreenBtn.textContent = active ? '退出全屏' : '全屏';
  canvas.focus();
}

async function enterFullscreenMode() {
  setFullscreenUi(true);
  try {
    if (!document.fullscreenElement && screenWrap.requestFullscreen) {
      await screenWrap.requestFullscreen();
    }
  } catch (error) {
    log(`已进入页面全屏；系统全屏不可用：${error.message}`);
  }
}

async function exitFullscreenMode() {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  }
  window.screen.orientation?.unlock?.();
  setFullscreenUi(false);
}

fullscreenBtn.addEventListener('click', async () => {
  if (document.fullscreenElement || appShell.classList.contains('theater-mode')) {
    await exitFullscreenMode();
    return;
  }
  await enterFullscreenMode();
});

fullscreenExitBtn.addEventListener('click', async () => {
  await exitFullscreenMode();
});

copyLinkBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    log('已复制当前控制台地址');
  } catch {
    log(window.location.href);
  }
});

document.addEventListener('fullscreenchange', () => {
  setFullscreenUi(Boolean(document.fullscreenElement));
});

canvas.addEventListener('keydown', (event) => {
  const namedKeys = new Set([
    'Enter',
    'Escape',
    'Backspace',
    'Tab',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Home',
    'End',
    'PageUp',
    'PageDown',
  ]);

  if (namedKeys.has(event.key)) {
    send({
      type: 'key_press',
      key: event.key,
      modifiers: ['shift', 'control', 'option', 'command'].filter((name) => {
        const prop = name === 'option' ? 'altKey' : name === 'command' ? 'metaKey' : `${name}Key`;
        return event[prop];
      }),
    });
    event.preventDefault();
    return;
  }

  if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
    send({ type: 'type_text', text: event.key });
    event.preventDefault();
  }
});

sendText.addEventListener('click', () => {
  const text = textInput.value;
  if (!text) return;
  send({ type: 'type_text', text });
  log(`已发送 ${text.length} 个字符`);
});

clearText.addEventListener('click', () => {
  textInput.value = '';
});

document.querySelectorAll('[data-key]').forEach((button) => {
  button.addEventListener('click', () => {
    send({ type: 'key_press', key: button.dataset.key });
    canvas.focus();
  });
});

window.addEventListener('beforeunload', () => {
  if (dragLocked || remotePointerDown) sendPointer('pointer_up');
  ws?.close();
});

setTouchMode(touchMode, false);
applyViewTransform();
connect();
