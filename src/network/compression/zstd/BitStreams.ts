export class ForwardBitReader {
  private position = 0;

  constructor(private readonly bytes: Uint8Array, private readonly start: number, private readonly end: number) {}

  read(count: number): number {
    let value = 0;
    for (let index = 0; index < count; index++) {
      const absolute = this.position + index;
      const byte = this.start + (absolute >> 3);
      const bit = byte < this.end ? (this.bytes[byte] >> (absolute & 7)) & 1 : 0;
      value += bit * 2 ** index;
    }
    this.position += count;
    return value;
  }

  get overrun(): boolean {
    return this.position > (this.end - this.start) * 8;
  }

  get consumedBytes(): number {
    return (this.position + 7) >> 3;
  }

  get bitPosition(): number {
    return this.position;
  }
}

export class ReverseBitReader {
  private remaining: number;
  private overrunBits = 0;

  constructor(private readonly bytes: Uint8Array, private readonly start: number, private readonly end: number) {
    const last = end > start ? bytes[end - 1] : 0;
    if (last === 0) {
      this.remaining = -1;
      return;
    }
    this.remaining = (end - start - 1) * 8 + (31 - Math.clz32(last));
  }

  get valid(): boolean {
    return this.remaining >= 0;
  }

  read(count: number): number {
    if (count === 0) return 0;
    this.remaining -= count;
    let value = 0;
    for (let index = 0; index < count; index++) {
      const absolute = this.remaining + index;
      const bit = absolute < 0 ? 0 : (this.bytes[this.start + (absolute >> 3)] >> (absolute & 7)) & 1;
      value += bit * 2 ** index;
    }
    if (this.remaining < 0) this.overrunBits = Math.max(this.overrunBits, -this.remaining);
    return value;
  }

  peek(count: number): number {
    let value = 0;
    const base = this.remaining - count;
    for (let index = 0; index < count; index++) {
      const absolute = base + index;
      const bit = absolute < 0 ? 0 : (this.bytes[this.start + (absolute >> 3)] >> (absolute & 7)) & 1;
      value += bit * 2 ** index;
    }
    return value;
  }

  skip(count: number): void {
    this.remaining -= count;
    if (this.remaining < 0) this.overrunBits = Math.max(this.overrunBits, -this.remaining);
  }

  get exhausted(): boolean {
    return this.remaining === 0;
  }

  get overrun(): boolean {
    return this.overrunBits > 0;
  }

  get bitsLeft(): number {
    return this.remaining;
  }
}

export class ReverseBitWriter {
  private bytes = new Uint8Array(256);
  private bitLength = 0;

  addBits(value: number, count: number): void {
    if (count === 0) return;
    this.ensure(this.bitLength + count);
    for (let index = 0; index < count; index++) {
      if (Math.floor(value / 2 ** index) % 2 === 1) this.bytes[(this.bitLength + index) >> 3] |= 1 << ((this.bitLength + index) & 7);
    }
    this.bitLength += count;
  }

  private ensure(bits: number): void {
    const needed = (bits + 7) >> 3;
    if (needed <= this.bytes.length) return;
    let capacity = this.bytes.length;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.bytes);
    this.bytes = grown;
  }

  close(): Uint8Array {
    this.addBits(1, 1);
    return this.bytes.slice(0, (this.bitLength + 7) >> 3);
  }

  get length(): number {
    return this.bitLength;
  }
}
