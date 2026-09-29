const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SshWriter {
  private readonly chunks: Uint8Array[] = [];

  writeByte(b: number): this {
    this.chunks.push(new Uint8Array([b & 0xff]));
    return this;
  }

  writeUint32(n: number): this {
    this.chunks.push(new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]));
    return this;
  }

  writeUint64(n: number): this {
    const hi = Math.floor(n / 0x100000000);
    const lo = n >>> 0;
    return this.writeUint32(hi).writeUint32(lo);
  }

  writeString(s: string): this {
    return this.writeBytes(encoder.encode(s));
  }

  writeBytes(bytes: Uint8Array): this {
    return this.writeUint32(bytes.length).writeRaw(bytes);
  }

  writeMpint(n: bigint): this {
    if (n < 0n) throw new RangeError('ssh: negative mpint');
    if (n === 0n) return this.writeUint32(0);
    let hex = n.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    const magnitude = new Uint8Array(hex.length / 2);
    for (let i = 0; i < magnitude.length; i++) magnitude[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (magnitude[0] & 0x80) {
      const padded = new Uint8Array(magnitude.length + 1);
      padded.set(magnitude, 1);
      return this.writeBytes(padded);
    }
    return this.writeBytes(magnitude);
  }

  writeRaw(bytes: Uint8Array): this {
    this.chunks.push(bytes);
    return this;
  }

  toBytes(): Uint8Array {
    const total = this.chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of this.chunks) { out.set(c, offset); offset += c.length; }
    return out;
  }
}

export class SshReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  private require(n: number): void {
    if (this.offset + n > this.bytes.length) throw new RangeError('ssh: truncated data');
  }

  readByte(): number {
    this.require(1);
    return this.bytes[this.offset++];
  }

  readUint32(): number {
    this.require(4);
    const [a, b, c, d] = [this.bytes[this.offset], this.bytes[this.offset + 1], this.bytes[this.offset + 2], this.bytes[this.offset + 3]];
    this.offset += 4;
    return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  }

  readUint64(): number {
    const hi = this.readUint32();
    const lo = this.readUint32();
    return hi * 0x100000000 + lo;
  }

  readString(): string {
    return decoder.decode(this.readBytes());
  }

  readBytes(): Uint8Array {
    return this.readRaw(this.readUint32());
  }

  readMpint(): bigint {
    const bytes = this.readBytes();
    if (bytes.length > 0 && bytes[0] & 0x80) throw new RangeError('ssh: negative mpint');
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    return n;
  }

  readRaw(len: number): Uint8Array {
    this.require(len);
    const value = this.bytes.slice(this.offset, this.offset + len);
    this.offset += len;
    return value;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }
}
