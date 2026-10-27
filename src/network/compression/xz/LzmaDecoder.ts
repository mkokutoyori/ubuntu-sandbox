const PROB_INIT = 1024;
const STATES = 12;
const POS_STATES_MAX = 16;
const LEN_LOW_SYMBOLS = 8;
const LEN_MID_SYMBOLS = 8;
const LEN_HIGH_SYMBOLS = 256;
const MATCH_LEN_MIN = 2;
const DIST_STATES = 4;
const DIST_SLOT_BITS = 6;
const DIST_MODEL_START = 4;
const DIST_MODEL_END = 14;
const FULL_DISTANCES = 128;
const ALIGN_BITS = 4;
const LITERAL_CODER_SIZE = 0x300;
const TOP_VALUE = 1 << 24;

export class LzmaError extends Error {}

class RangeDecoder {
  range = 0xffffffff;
  code = 0;
  position: number;

  constructor(private readonly input: Uint8Array, start: number, private readonly end: number) {
    this.position = start;
    if (end - start < 5 || input[start] !== 0) throw new LzmaError('range coder header');
    this.position = start + 1;
    for (let index = 0; index < 4; index++) this.code = ((this.code << 8) | input[this.position++]) >>> 0;
  }

  private normalize(): void {
    if (this.range >>> 0 < TOP_VALUE) {
      if (this.position >= this.end) throw new LzmaError('range coder input exhausted');
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.input[this.position++]) >>> 0;
    }
  }

  bit(probs: Uint16Array, index: number): number {
    this.normalize();
    const prob = probs[index];
    const bound = (this.range >>> 11) * prob;
    if (this.code < bound) {
      this.range = bound;
      probs[index] = prob + ((2048 - prob) >>> 5);
      return 0;
    }
    this.range = (this.range - bound) >>> 0;
    this.code = (this.code - bound) >>> 0;
    probs[index] = prob - (prob >>> 5);
    return 1;
  }

  direct(count: number): number {
    let result = 0;
    for (let index = 0; index < count; index++) {
      this.normalize();
      this.range >>>= 1;
      let bit = 0;
      if (this.code >= this.range) {
        this.code = (this.code - this.range) >>> 0;
        bit = 1;
      }
      result = ((result << 1) | bit) >>> 0;
    }
    return result;
  }

  tree(probs: Uint16Array, offset: number, bits: number): number {
    let symbol = 1;
    for (let index = 0; index < bits; index++) symbol = (symbol << 1) | this.bit(probs, offset + symbol);
    return symbol - (1 << bits);
  }

  reverseTree(probs: Uint16Array, offset: number, bits: number): number {
    let symbol = 1;
    let result = 0;
    for (let index = 0; index < bits; index++) {
      const bit = this.bit(probs, offset + symbol);
      symbol = (symbol << 1) | bit;
      result |= bit << index;
    }
    return result;
  }

  finished(): boolean {
    this.normalize();
    return this.code === 0 && this.position === this.end;
  }
}

class LengthDecoder {
  readonly choice = new Uint16Array(2).fill(PROB_INIT);
  readonly low = new Uint16Array(POS_STATES_MAX * LEN_LOW_SYMBOLS).fill(PROB_INIT);
  readonly mid = new Uint16Array(POS_STATES_MAX * LEN_MID_SYMBOLS).fill(PROB_INIT);
  readonly high = new Uint16Array(LEN_HIGH_SYMBOLS).fill(PROB_INIT);

  decode(rc: RangeDecoder, posState: number): number {
    if (rc.bit(this.choice, 0) === 0) return rc.tree(this.low, posState * LEN_LOW_SYMBOLS, 3);
    if (rc.bit(this.choice, 1) === 0) return LEN_LOW_SYMBOLS + rc.tree(this.mid, posState * LEN_MID_SYMBOLS, 3);
    return LEN_LOW_SYMBOLS + LEN_MID_SYMBOLS + rc.tree(this.high, 0, 8);
  }
}

export interface LzmaProperties {
  readonly lc: number;
  readonly lp: number;
  readonly pb: number;
}

export function parseLzmaProperties(byte: number): LzmaProperties {
  if (byte >= 9 * 5 * 5) throw new LzmaError('properties');
  const pb = Math.floor(byte / 45);
  const rest = byte - pb * 45;
  const lp = Math.floor(rest / 9);
  const lc = rest - lp * 9;
  return { lc, lp, pb };
}

export class LzmaDecoder {
  private properties: LzmaProperties = { lc: 0, lp: 0, pb: 0 };
  private literal = new Uint16Array(0);
  private readonly isMatch = new Uint16Array(STATES * POS_STATES_MAX);
  private readonly isRep = new Uint16Array(STATES);
  private readonly isRepG0 = new Uint16Array(STATES);
  private readonly isRepG1 = new Uint16Array(STATES);
  private readonly isRepG2 = new Uint16Array(STATES);
  private readonly isRep0Long = new Uint16Array(STATES * POS_STATES_MAX);
  private readonly distSlot = new Uint16Array(DIST_STATES << DIST_SLOT_BITS);
  private readonly distSpecial = new Uint16Array(FULL_DISTANCES - DIST_MODEL_END);
  private readonly align = new Uint16Array(1 << ALIGN_BITS);
  private readonly matchLength = new LengthDecoder();
  private readonly repLength = new LengthDecoder();
  private state = 0;
  private rep0 = 0;
  private rep1 = 0;
  private rep2 = 0;
  private rep3 = 0;

  setProperties(properties: LzmaProperties): void {
    if (properties.lc + properties.lp > 4) throw new LzmaError('lc + lp');
    this.properties = properties;
    this.literal = new Uint16Array(LITERAL_CODER_SIZE << (properties.lc + properties.lp));
  }

  resetState(): void {
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
    for (const probs of [this.literal, this.isMatch, this.isRep, this.isRepG0, this.isRepG1, this.isRepG2, this.isRep0Long, this.distSlot, this.distSpecial, this.align,
      this.matchLength.choice, this.matchLength.low, this.matchLength.mid, this.matchLength.high, this.repLength.choice, this.repLength.low, this.repLength.mid, this.repLength.high]) probs.fill(PROB_INIT);
  }

  decodeChunk(input: Uint8Array, start: number, end: number, output: number[], dictStart: number, unpackedSize: number): void {
    const rc = new RangeDecoder(input, start, end);
    const { lc, lp, pb } = this.properties;
    const posMask = (1 << pb) - 1;
    const literalPosMask = (1 << lp) - 1;
    const target = output.length + unpackedSize;
    while (output.length < target) {
      const position = output.length - dictStart;
      const posState = position & posMask;
      if (rc.bit(this.isMatch, (this.state << 4) + posState) === 0) {
        this.decodeLiteral(rc, output, position, lc, literalPosMask);
        continue;
      }
      let length: number;
      if (rc.bit(this.isRep, this.state) === 0) {
        length = this.matchLength.decode(rc, posState);
        this.rep3 = this.rep2;
        this.rep2 = this.rep1;
        this.rep1 = this.rep0;
        this.rep0 = this.decodeDistance(rc, length);
        this.state = this.state < 7 ? 7 : 10;
        if (this.rep0 === 0xffffffff) throw new LzmaError('end marker in LZMA2');
      } else {
        if (position === 0) throw new LzmaError('repeat match without history');
        if (rc.bit(this.isRepG0, this.state) === 0) {
          if (rc.bit(this.isRep0Long, (this.state << 4) + posState) === 0) {
            this.state = this.state < 7 ? 9 : 11;
            this.copy(output, dictStart, 1);
            continue;
          }
        } else {
          let distance: number;
          if (rc.bit(this.isRepG1, this.state) === 0) distance = this.rep1;
          else {
            if (rc.bit(this.isRepG2, this.state) === 0) distance = this.rep2;
            else {
              distance = this.rep3;
              this.rep3 = this.rep2;
            }
            this.rep2 = this.rep1;
          }
          this.rep1 = this.rep0;
          this.rep0 = distance;
        }
        length = this.repLength.decode(rc, posState);
        this.state = this.state < 7 ? 8 : 11;
      }
      this.copy(output, dictStart, length + MATCH_LEN_MIN, target);
    }
    if (!rc.finished()) throw new LzmaError('chunk did not end with the range coder');
  }

  private decodeLiteral(rc: RangeDecoder, output: number[], position: number, lc: number, literalPosMask: number): void {
    const previous = position === 0 ? 0 : output[output.length - 1];
    const base = LITERAL_CODER_SIZE * (((position & literalPosMask) << lc) + (previous >>> (8 - lc)));
    let symbol = 1;
    if (this.state >= 7) {
      if (this.rep0 >= position) throw new LzmaError('literal distance');
      let matchByte = output[output.length - this.rep0 - 1];
      let offset = 0x100;
      while (symbol < 0x100) {
        matchByte <<= 1;
        const matchBit = matchByte & offset;
        const bit = rc.bit(this.literal, base + offset + matchBit + symbol);
        symbol = (symbol << 1) | bit;
        offset &= bit === 0 ? ~matchBit : matchBit;
      }
    } else {
      while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(this.literal, base + symbol);
    }
    output.push(symbol & 0xff);
    this.state = this.state < 4 ? 0 : this.state < 10 ? this.state - 3 : this.state - 6;
  }

  private decodeDistance(rc: RangeDecoder, length: number): number {
    const lengthState = Math.min(length, DIST_STATES - 1);
    const slot = rc.tree(this.distSlot, lengthState << DIST_SLOT_BITS, DIST_SLOT_BITS);
    if (slot < DIST_MODEL_START) return slot;
    const directBits = (slot >>> 1) - 1;
    let distance = ((2 | (slot & 1)) << directBits) >>> 0;
    if (slot < DIST_MODEL_END) return (distance + rc.reverseTree(this.distSpecial, distance - slot - 1, directBits)) >>> 0;
    distance = (distance + (rc.direct(directBits - ALIGN_BITS) << ALIGN_BITS)) >>> 0;
    return (distance + rc.reverseTree(this.align, 0, ALIGN_BITS)) >>> 0;
  }

  private copy(output: number[], dictStart: number, length: number, target = output.length + length): void {
    const available = output.length - dictStart;
    if (this.rep0 >= available) throw new LzmaError('distance beyond the dictionary');
    if (output.length + length > target) throw new LzmaError('match past the chunk');
    for (let index = 0; index < length; index++) output.push(output[output.length - this.rep0 - 1]);
  }
}
