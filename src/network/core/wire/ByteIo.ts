export class ByteWriter {
  private readonly chunks: number[] = [];
  u8(value: number): this { this.chunks.push(value & 0xff); return this; }
  u16(value: number): this { return this.u8(value >> 8).u8(value); }
  u32(value: number): this { return this.u16(value >>> 16).u16(value & 0xffff); }
  bytes(values: ArrayLike<number>): this { for (let i = 0; i < values.length; i++) this.u8(values[i]); return this; }
  get length(): number { return this.chunks.length; }
  toBytes(): Uint8Array { return Uint8Array.from(this.chunks); }
}

export class ByteReader {
  private position = 0;
  constructor(private readonly data: Uint8Array) {}
  get remaining(): number { return this.data.length - this.position; }
  u8(): number { return this.data[this.position++]; }
  u16(): number { return (this.u8() << 8) | this.u8(); }
  u32(): number { return ((this.u16() << 16) | this.u16()) >>> 0; }
  take(count: number): Uint8Array {
    const slice = this.data.subarray(this.position, this.position + count);
    this.position += count;
    return slice;
  }
}
