// Connection lifecycle is independent from gestures: stale sockets, fetches and
// heartbeat timers must never revive an old control session.
export class RemoteConnection {
  constructor({ token, onState, onStatus, onFrame, onError, onReset, onInputResult }) {
    Object.assign(this, { token, onState, onStatus, onFrame, onError, onReset, onInputResult });
    this.socket = null;
    this.generation = 0;
    this.retryDelay = 1000;
    this.stopped = false;
    this.authFailed = false;
  }

  get isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  send(payload) {
    if (!this.isOpen) return false;
    try {
      this.socket.send(JSON.stringify(payload));
      return true;
    } catch {
      this.reconnect();
      return false;
    }
  }

  invalidate() {
    this.onReset();
    this.generation += 1;
    clearTimeout(this.retryTimer);
    clearTimeout(this.connectTimer);
    clearTimeout(this.probeTimer);
    clearInterval(this.heartbeatTimer);
    this.controller?.abort();
    this.controller = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close();
  }

  scheduleRetry(message) {
    if (this.stopped || this.authFailed) return;
    this.onState('closed', '已断开', message);
    const delay = this.retryDelay;
    this.retryDelay = Math.min(8000, this.retryDelay * 1.5);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  async connect() {
    this.invalidate();
    if (this.stopped) return;
    if (!this.token || this.authFailed) {
      this.onState('auth', '需要连接密钥', this.authFailed
        ? '连接密钥已失效，请从 Mac 获取新的连接地址或密钥。'
        : '扫描 Mac 上的二维码，或粘贴连接地址 / 密钥。');
      return;
    }
    if (navigator.onLine === false) {
      this.onState('closed', '网络已断开', '请连接到 Mac 所在的局域网，网络恢复后会自动重连。');
      return;
    }
    const generation = this.generation;
    this.onState('connecting', '连接中', '正在连接 Mac…');
    const controller = new AbortController();
    this.controller = controller;
    const fetchTimer = setTimeout(() => controller.abort(), 8000);
    try {
      // The browser hides WS handshake HTTP errors; preflight distinguishes an
      // expired credential and a full server from a transient network failure.
      const response = await fetch('/api/info', {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: controller.signal,
        cache: 'no-store',
      });
      if (generation !== this.generation) return;
      if (response.status === 401 || response.status === 403) {
        this.authFailed = true;
        this.onState('auth', '连接密钥无效', '请从 Mac 获取新的连接地址或密钥，然后重新连接。');
        return;
      }
      if (!response.ok) throw new Error(response.status === 503 ? '连接人数已满，请稍后重试。' : `服务暂不可用（${response.status}）`);
      const status = await response.json();
      if (generation !== this.generation) return;
      this.onStatus(status);
      if (status.maxClients && status.connectedClients >= status.maxClients) {
        throw new Error('连接人数已满，等待其他设备退出后重连。');
      }
      this.openSocket(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      this.scheduleRetry(error.name === 'AbortError'
        ? '连接超时，请确认 Mac 已开机、服务已启动，且两台设备在同一局域网。'
        : error.message === 'Failed to fetch' ? '无法连接 Mac，正在重试。请检查局域网和服务状态。' : error.message);
    } finally {
      clearTimeout(fetchTimer);
      if (this.controller === controller) this.controller = null;
    }
  }

  openSocket(generation) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(this.token)}`);
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    const current = () => generation === this.generation && socket === this.socket;
    this.connectTimer = setTimeout(() => {
      if (current() && !this.isOpen) this.reconnect();
    }, 8000);
    socket.addEventListener('open', () => {
      if (!current()) return;
      clearTimeout(this.connectTimer);
      this.lastMessageAt = performance.now();
      this.retryDelay = 1000;
      this.onState('open', '已连接');
      this.heartbeatTimer = setInterval(() => {
        if (document.visibilityState !== 'hidden' && performance.now() - this.lastMessageAt > 5000) this.probe();
      }, 5000);
    });
    socket.addEventListener('message', (event) => {
      if (!current()) return;
      this.lastMessageAt = performance.now();
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
      if (typeof event.data !== 'string') {
        this.onFrame(event.data);
        return;
      }
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (payload.type === 'status') this.onStatus(payload);
      else if (payload.type === 'error') this.onError(payload);
      else if (payload.type === 'input_result') this.onInputResult?.(payload);
    });
    socket.addEventListener('close', () => {
      if (!current()) return;
      this.invalidate();
      this.scheduleRetry('连接已断开，正在自动重连。');
    });
    // close handles errors too, without scheduling a second retry.
    socket.addEventListener('error', () => {});
  }

  probe() {
    if (!this.isOpen || this.probeTimer) return;
    const generation = this.generation;
    if (!this.send({ type: 'ping' })) return;
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (generation === this.generation) this.reconnect();
    }, 2500);
  }

  reconnect(token = this.token) {
    if (token !== this.token) this.authFailed = false;
    this.token = token;
    this.stopped = false;
    this.retryDelay = 1000;
    return this.connect();
  }

  stop() {
    this.stopped = true;
    this.invalidate();
  }
}

// Shared by the recovery form and URL bootstrap; access links may use either
// the original query parameter or a fragment that is never sent in HTTP URLs.
export function accessTokenFrom(value, { allowBare = true } = {}) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return new URLSearchParams(url.hash.slice(1)).get('token') || url.searchParams.get('token') || '';
    } catch { return ''; }
  }
  return allowBare && !/[\s/?#]/.test(trimmed) ? trimmed : '';
}
