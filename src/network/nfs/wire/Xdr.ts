export class XdrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XdrError';
  }
}

const UNIT = 4;

function paddingFor(length: number): number {
  return (UNIT - (length % UNIT)) % UNIT;
}

export class XdrWriter {
  private readonly bytes: number[] = [];

  get length(): number {
    return this.bytes.length;
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }

  int32(value: number): this {
    return this.uint32(value >>> 0);
  }

  uint32(value: number): this {
    const v = value >>> 0;
    this.bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    return this;
  }

  enumeration(value: number): this {
    return this.int32(value);
  }

  boolean(value: boolean): this {
    return this.uint32(value ? 1 : 0);
  }

  uint64(value: bigint | number): this {
    const v = BigInt(value) & 0xffffffffffffffffn;
    this.uint32(Number(v >> 32n));
    this.uint32(Number(v & 0xffffffffn));
    return this;
  }

  int64(value: bigint | number): this {
    return this.uint64(BigInt(value) & 0xffffffffffffffffn);
  }

  fixedOpaque(data: Uint8Array, size: number): this {
    if (data.length !== size) {
      throw new XdrError(`fixed opaque of ${size} bytes received ${data.length}`);
    }
    for (const b of data) this.bytes.push(b);
    for (let i = paddingFor(size); i > 0; i--) this.bytes.push(0);
    return this;
  }

  variableOpaque(data: Uint8Array): this {
    this.uint32(data.length);
    for (const b of data) this.bytes.push(b);
    for (let i = paddingFor(data.length); i > 0; i--) this.bytes.push(0);
    return this;
  }

  string(value: string): this {
    return this.variableOpaque(new TextEncoder().encode(value));
  }

  optional<T>(value: T | null | undefined, encode: (writer: XdrWriter, present: T) => void): this {
    if (value === null || value === undefined) return this.boolean(false);
    this.boolean(true);
    encode(this, value);
    return this;
  }

  array<T>(values: readonly T[], encode: (writer: XdrWriter, item: T) => void): this {
    this.uint32(values.length);
    for (const item of values) encode(this, item);
    return this;
  }

  raw(data: Uint8Array): this {
    for (const b of data) this.bytes.push(b);
    return this;
  }
}

export class XdrReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  atEnd(): boolean {
    return this.offset >= this.bytes.length;
  }

  private take(count: number): Uint8Array {
    if (this.offset + count > this.bytes.length) {
      throw new XdrError(`read of ${count} bytes past end of stream at offset ${this.offset}`);
    }
    const slice = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  uint32(): number {
    const b = this.take(UNIT);
    return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  }

  int32(): number {
    return this.uint32() | 0;
  }

  enumeration(): number {
    return this.int32();
  }

  boolean(): boolean {
    const value = this.uint32();
    if (value > 1) throw new XdrError(`boolean encoded as ${value}`);
    return value === 1;
  }

  uint64(): bigint {
    return (BigInt(this.uint32()) << 32n) | BigInt(this.uint32());
  }

  int64(): bigint {
    const raw = this.uint64();
    return raw >= 0x8000000000000000n ? raw - 0x10000000000000000n : raw;
  }

  fixedOpaque(size: number): Uint8Array {
    const data = Uint8Array.from(this.take(size));
    this.take(paddingFor(size));
    return data;
  }

  variableOpaque(limit = 0xffffffff): Uint8Array {
    const size = this.uint32();
    if (size > limit) throw new XdrError(`variable opaque of ${size} bytes exceeds limit ${limit}`);
    return this.fixedOpaque(size);
  }

  string(limit = 0xffffffff): string {
    return new TextDecoder().decode(this.variableOpaque(limit));
  }

  optional<T>(decode: (reader: XdrReader) => T): T | null {
    return this.boolean() ? decode(this) : null;
  }

  array<T>(decode: (reader: XdrReader) => T): T[] {
    const count = this.uint32();
    const out: T[] = [];
    for (let i = 0; i < count; i++) out.push(decode(this));
    return out;
  }

  raw(count: number): Uint8Array {
    return Uint8Array.from(this.take(count));
  }
}
