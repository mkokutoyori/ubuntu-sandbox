const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const WINDOW_DESCRIPTOR = 0x38;
const MAX_BLOCK = 128 * 1024;

function blockHeader(size: number, last: boolean): number[] {
  const value = (size << 3) | (last ? 1 : 0);
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
}

export class ZstdStreamWriter {
  private headerWritten = false;
  private readonly pending: Uint8Array[] = [];
  private pendingBytes = 0;

  private header(): number[] {
    return [...MAGIC, 0x00, WINDOW_DESCRIPTOR];
  }

  private drain(last: boolean): Uint8Array {
    const out: number[] = [];
    if (!this.headerWritten) {
      out.push(...this.header());
      this.headerWritten = true;
    }
    const data = new Uint8Array(this.pendingBytes);
    let offset = 0;
    for (const chunk of this.pending) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    this.pending.length = 0;
    this.pendingBytes = 0;
    if (data.length === 0 && last) out.push(...blockHeader(0, true));
    for (let start = 0; start < data.length; start += MAX_BLOCK) {
      const block = data.subarray(start, Math.min(start + MAX_BLOCK, data.length));
      out.push(...blockHeader(block.length, last && start + MAX_BLOCK >= data.length));
      for (const byte of block) out.push(byte);
    }
    return Uint8Array.from(out);
  }

  write(data: Uint8Array, flush: boolean): Uint8Array {
    if (data.length > 0) {
      this.pending.push(data);
      this.pendingBytes += data.length;
    }
    if (flush || this.pendingBytes >= MAX_BLOCK) return this.drain(false);
    return new Uint8Array(0);
  }

  finish(): Uint8Array {
    if (!this.headerWritten && this.pendingBytes === 0) return new Uint8Array(0);
    return this.drain(true);
  }
}
