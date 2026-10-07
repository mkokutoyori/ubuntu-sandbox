import { bytesToHex, hexToBytes } from '@/crypto/encoding';

export class TlsDecodeError extends Error {}

export class TlsWriter {
  private readonly parts: number[] = [];

  u8(value: number): this {
    this.parts.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    return this.u8(value >> 8).u8(value);
  }

  u24(value: number): this {
    return this.u8(value >> 16).u16(value);
  }

  u32(value: number): this {
    return this.u16(Math.floor(value / 0x10000)).u16(value);
  }

  bytes(value: Uint8Array): this {
    for (const byte of value) this.parts.push(byte);
    return this;
  }

  hex(value: string): this {
    return this.bytes(hexToBytes(value));
  }

  vector(lengthBytes: 1 | 2 | 3, fill: (inner: TlsWriter) => void): this {
    const inner = new TlsWriter();
    fill(inner);
    const body = inner.toBytes();
    if (lengthBytes === 1) this.u8(body.length);
    else if (lengthBytes === 2) this.u16(body.length);
    else this.u24(body.length);
    return this.bytes(body);
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

export class TlsReader {
  private offset = 0;

  constructor(private readonly data: Uint8Array) {}

  get remaining(): number {
    return this.data.length - this.offset;
  }

  get done(): boolean {
    return this.offset >= this.data.length;
  }

  private need(count: number): void {
    if (this.remaining < count) throw new TlsDecodeError('truncated structure');
  }

  u8(): number {
    this.need(1);
    return this.data[this.offset++];
  }

  u16(): number {
    return (this.u8() << 8) | this.u8();
  }

  u24(): number {
    return (this.u8() << 16) | this.u16();
  }

  u32(): number {
    return this.u16() * 0x10000 + this.u16();
  }

  bytes(count: number): Uint8Array {
    this.need(count);
    const out = this.data.slice(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }

  hex(count: number): string {
    return bytesToHex(this.bytes(count));
  }

  vector(lengthBytes: 1 | 2 | 3): TlsReader {
    const length = lengthBytes === 1 ? this.u8() : lengthBytes === 2 ? this.u16() : this.u24();
    return new TlsReader(this.bytes(length));
  }

  rest(): Uint8Array {
    return this.bytes(this.remaining);
  }
}
