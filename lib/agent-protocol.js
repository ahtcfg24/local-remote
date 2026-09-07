// A bounded decoder for the native [type][uint32 length][payload] stream.
// stdout reads may split headers or contain multiple packets.
export class AgentPacketDecoder {
  constructor(onPacket, { maxFrameBytes = 16 * 1024 * 1024, maxJsonBytes = 64 * 1024 } = {}) {
    this.onPacket = onPacket;
    this.maxFrameBytes = maxFrameBytes;
    this.maxJsonBytes = maxJsonBytes;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 5) {
      const type = this.buffer[0];
      const length = this.buffer.readUInt32BE(1);
      const limit = type === 0x46 ? this.maxFrameBytes : type === 0x4a ? this.maxJsonBytes : 0;
      if (!limit || length === 0 || length > limit) throw new Error('Invalid native packet type or length');
      if (this.buffer.length < 5 + length) return;
      const payload = this.buffer.subarray(5, 5 + length);
      this.buffer = this.buffer.subarray(5 + length);
      this.onPacket(type, payload);
    }
  }
}
