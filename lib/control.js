const BUTTONS = new Set(['left', 'right', 'middle']);
const MODIFIERS = new Set(['shift', 'control', 'ctrl', 'option', 'alt', 'command', 'cmd', 'meta']);
const NAMED_KEYS = new Set([
  'enter', 'return', 'tab', 'space', 'escape', 'esc', 'backspace', 'delete', 'forwarddelete',
  'arrowleft', 'left', 'arrowright', 'right', 'arrowdown', 'down', 'arrowup', 'up',
  'home', 'end', 'pageup', 'pagedown', 'capslock',
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
]);
const POINTER_COMMANDS = { pointer_move: 'move', pointer_drag: 'drag', pointer_down: 'down', pointer_up: 'up', click: 'click' };

function finite(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} 必须是有限数字`);
  return value;
}

function boundedInteger(value, fallback, max, field) {
  if (value === undefined) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(finite(value, field))));
}

// Validate before serializing across the process boundary. In particular, Number("1e999")
// and JSON numbers that overflow must never reach Swift's integer conversions.
export function parseControlMessage(raw, screen = {}) {
  const message = JSON.parse(raw);
  if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
    throw new Error('控制消息格式无效');
  }
  const type = message.type;
  if (type === 'ping' || type === 'release_inputs') return { type };
  const modifiers = [...new Set(Array.isArray(message.modifiers)
    ? message.modifiers.filter((value) => typeof value === 'string').map((value) => value.toLowerCase()).filter((value) => MODIFIERS.has(value))
    : [])].slice(0, 4);

  if (Object.hasOwn(POINTER_COMMANDS, type)) {
    const button = message.button === undefined ? 'left' : message.button;
    if (!BUTTONS.has(button)) throw new Error('不支持的鼠标按钮');
    const width = Number.isFinite(screen.width) && screen.width > 0 ? screen.width : 65536;
    const height = Number.isFinite(screen.height) && screen.height > 0 ? screen.height : 65536;
    return { type, command: {
      cmd: POINTER_COMMANDS[type],
      x: Math.min(width - 1, Math.max(0, finite(message.x, 'x'))),
      y: Math.min(height - 1, Math.max(0, finite(message.y, 'y'))),
      button,
      count: boundedInteger(message.count, 1, 3, 'count'),
      modifiers,
    }, cost: 1 };
  }
  if (type === 'wheel') {
    return { type, command: {
      cmd: 'wheel',
      dx: Math.min(10000, Math.max(-10000, finite(message.dx ?? 0, 'dx'))),
      dy: Math.min(10000, Math.max(-10000, finite(message.dy ?? 0, 'dy'))),
    }, cost: 1 };
  }
  if (type === 'key_press') {
    if (typeof message.key !== 'string' || !message.key || message.key.length > 32) throw new Error('按键无效');
    const key = message.key;
    if (!NAMED_KEYS.has(key.toLowerCase()) && Array.from(key).length !== 1) throw new Error('不支持的按键');
    const repeat = boundedInteger(message.repeat, 1, 2000, 'repeat');
    return { type, command: { cmd: 'key', key, modifiers, repeat }, cost: repeat };
  }
  if (type === 'type_text') {
    if (typeof message.text !== 'string' || !message.text || message.text.length > 4000) {
      throw new Error('文本长度必须为 1–4000 个字符，请分段发送');
    }
    if (message.requestId !== undefined && (typeof message.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(message.requestId))) throw new Error('请求标识无效');
    return { type, requestId: message.requestId, command: { cmd: 'text', text: message.text }, cost: message.text.length };
  }
  throw new Error('不支持的控制消息');
}

export class RateBudget {
  constructor(capacity, refillPerSecond) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.tokens = capacity;
    this.updatedAt = performance.now();
  }

  consume(cost = 1) {
    const now = performance.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.updatedAt) / 1000 * this.refillPerSecond);
    this.updatedAt = now;
    if (cost > this.tokens) return false;
    this.tokens -= cost;
    return true;
  }
}
