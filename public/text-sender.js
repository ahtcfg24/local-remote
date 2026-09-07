// A transport acknowledgement means the Mac input service accepted a complete
// message. A timeout is deliberately uncertain: replay could type it twice.
export class TextSender {
  constructor({ send, timeoutMs = 6000 }) {
    this.transportSend = send;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.sequence = 0;
  }

  send(text) {
    if (typeof text !== 'string' || !text) return Promise.reject(new Error('没有可发送的文本'));
    if (text.length > 4000) return Promise.reject(new Error('这段文字过长，请分段发送（每段建议 2,000 字以内）'));
    const requestId = `text-${Date.now().toString(36)}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('发送结果未确认，文字可能已到达 Mac'));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      let sent = false;
      try { sent = this.transportSend({ type: 'type_text', text, requestId }); } catch {}
      if (!sent && this.pending.has(requestId)) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error('连接中断，发送结果未确认'));
      }
    });
  }

  settle(payload) {
    const pending = this.pending.get(payload.requestId);
    if (!pending) return;
    if (payload.type !== 'input_result' && payload.type !== 'error') return;
    this.pending.delete(payload.requestId);
    clearTimeout(pending.timer);
    if (payload.type === 'input_result' && payload.accepted === true) pending.resolve();
    else pending.reject(new Error(payload.message || 'Mac 未接受这段文字'));
  }

  reset() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('连接中断，发送结果未确认；请检查 Mac 后再重试'));
    }
    this.pending.clear();
  }
}
