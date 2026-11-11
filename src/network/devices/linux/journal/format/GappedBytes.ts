const WORD = 4;
const WORD_RADIX = 0x100000000;

export class GappedBytes {
  private dense: Uint8Array;
  private view: DataView;
  private gapStart = 0;
  private gapLength = 0;
  private readonly gapWords = new Map<number, number>();

  private logicalCapacity: number;

  constructor(private readonly initialCapacity: number) {
    this.dense = new Uint8Array(initialCapacity);
    this.view = new DataView(this.dense.buffer);
    this.logicalCapacity = initialCapacity;
  }

  get capacity(): number {
    return this.logicalCapacity;
  }

  openGap(start: number, length: number): void {
    if (this.gapLength !== 0) throw new Error('a gap is already open');
    if (start % WORD !== 0 || length % WORD !== 0) throw new Error('a gap is word aligned');
    const displaced = this.dense.slice(start, Math.min(this.dense.length, start + length));
    this.dense.copyWithin(start, start + length);
    this.dense.fill(0, Math.max(start, this.dense.length - length));
    this.gapStart = start;
    this.gapLength = length;
    this.writeIntoGap(displaced, start);
  }

  ensure(length: number): void {
    while (this.logicalCapacity < length) this.logicalCapacity *= 2;
    const needed = length <= this.gapStart ? length : Math.max(this.gapStart, length - this.gapLength);
    if (needed <= this.dense.length) return;
    let capacity = this.dense.length;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.dense);
    this.dense = grown;
    this.view = new DataView(grown.buffer);
  }

  load(bytes: Uint8Array): void {
    this.gapWords.clear();
    const gapEnd = this.gapStart + this.gapLength;
    const head = bytes.subarray(0, Math.min(bytes.length, this.gapStart));
    const tail = bytes.length > gapEnd ? bytes.subarray(gapEnd) : new Uint8Array(0);
    this.dense = new Uint8Array(Math.max(this.initialCapacity, this.gapStart + tail.length));
    this.view = new DataView(this.dense.buffer);
    this.dense.set(head);
    this.dense.set(tail, this.gapStart);
    this.logicalCapacity = Math.max(this.initialCapacity, bytes.length);
    if (bytes.length > this.gapStart) this.writeIntoGap(bytes.subarray(this.gapStart, Math.min(bytes.length, gapEnd)), this.gapStart);
  }

  u8(offset: number): number {
    if (this.inGap(offset)) return (this.gapWord(offset - (offset % WORD)) >>> (8 * (offset % WORD))) & 0xff;
    return this.dense[this.physical(offset)] ?? 0;
  }

  setU8(offset: number, value: number): void {
    if (!this.inGap(offset)) {
      this.dense[this.physical(offset)] = value;
      return;
    }
    const word = offset - (offset % WORD);
    const shift = 8 * (offset % WORD);
    this.setGapWord(word, ((this.gapWord(word) & ~(0xff << shift)) | ((value & 0xff) << shift)) >>> 0);
  }

  u32(offset: number): number {
    if (this.clearOfGap(offset, WORD)) {
      const at = this.physical(offset);
      return at + WORD <= this.dense.length ? this.view.getUint32(at, true) : 0;
    }
    if (offset % WORD === 0 && this.inGap(offset)) return this.gapWord(offset);
    return (this.u8(offset) | (this.u8(offset + 1) << 8) | (this.u8(offset + 2) << 16) | (this.u8(offset + 3) << 24)) >>> 0;
  }

  setU32(offset: number, value: number): void {
    if (this.clearOfGap(offset, WORD)) this.view.setUint32(this.physical(offset), value, true);
    else if (offset % WORD === 0 && this.inGap(offset)) this.setGapWord(offset, value >>> 0);
    else for (let byte = 0; byte < WORD; byte++) this.setU8(offset + byte, (value >>> (8 * byte)) & 0xff);
  }

  u64(offset: number): number {
    return this.u32(offset + WORD) * WORD_RADIX + this.u32(offset);
  }

  setU64(offset: number, value: number): void {
    this.setU32(offset, value % WORD_RADIX);
    this.setU32(offset + WORD, Math.floor(value / WORD_RADIX));
  }

  bigU64(offset: number): bigint {
    return (BigInt(this.u32(offset + WORD)) << 32n) | BigInt(this.u32(offset));
  }

  setBigU64(offset: number, value: bigint): void {
    this.setU32(offset, Number(value & 0xffffffffn));
    this.setU32(offset + WORD, Number((value >> 32n) & 0xffffffffn));
  }

  set(bytes: Uint8Array, offset: number): void {
    if (this.clearOfGap(offset, bytes.length)) {
      this.dense.set(bytes, this.physical(offset));
      return;
    }
    for (let index = 0; index < bytes.length; index++) this.setU8(offset + index, bytes[index]);
  }

  slice(offset: number, length: number): Uint8Array {
    const end = Math.min(offset + length, this.logicalCapacity);
    const out = new Uint8Array(Math.max(0, end - offset));
    const gapEnd = this.gapStart + this.gapLength;
    if (offset < this.gapStart) out.set(this.dense.subarray(offset, Math.min(end, this.gapStart)), 0);
    if (end > gapEnd) {
      const from = Math.max(offset, gapEnd);
      out.set(this.dense.subarray(from - this.gapLength, end - this.gapLength), from - offset);
    }
    if (end <= this.gapStart || offset >= gapEnd) return out;
    for (const [word, value] of this.gapWords) {
      for (let byte = 0; byte < WORD; byte++) {
        const at = word + byte;
        if (at >= offset && at < end) out[at - offset] = (value >>> (8 * byte)) & 0xff;
      }
    }
    return out;
  }

  private clearOfGap(offset: number, length: number): boolean {
    return offset + length <= this.gapStart || offset >= this.gapStart + this.gapLength;
  }

  private inGap(offset: number): boolean {
    return offset >= this.gapStart && offset < this.gapStart + this.gapLength;
  }

  private physical(offset: number): number {
    return offset < this.gapStart ? offset : offset - this.gapLength;
  }

  private gapWord(word: number): number {
    return this.gapWords.get(word) ?? 0;
  }

  private setGapWord(word: number, value: number): void {
    if (value === 0) this.gapWords.delete(word);
    else this.gapWords.set(word, value);
  }

  private writeIntoGap(bytes: Uint8Array, offset: number): void {
    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] !== 0) this.setU8(offset + index, bytes[index]);
    }
  }
}
