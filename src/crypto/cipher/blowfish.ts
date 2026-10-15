const P_WORDS = 18;
const S_BOX_WORDS = 256;
const S_BOXES = 4;
const INIT_WORDS = P_WORDS + S_BOXES * S_BOX_WORDS;
const GUARD_BITS = 64;

function arctanInverse(x: bigint, scale: bigint): bigint {
  const x2 = x * x;
  let term = scale / x;
  let sum = term;
  let divisor = 1n;
  let sign = -1n;
  while (term !== 0n) {
    term /= x2;
    divisor += 2n;
    sum += (sign * term) / divisor;
    sign = -sign;
  }
  return sum;
}

function piFractionWords(count: number): Uint32Array {
  const bits = BigInt(count * 32 + GUARD_BITS);
  const scale = 1n << bits;
  const pi = 16n * arctanInverse(5n, scale) - 4n * arctanInverse(239n, scale);
  const fraction = (pi - 3n * scale) >> BigInt(GUARD_BITS);
  return fillWords(new Uint32Array(count), fraction, count - 1);
}

function fillWords(words: Uint32Array, fraction: bigint, from: number): Uint32Array {
  let value = fraction;
  for (let i = from; i >= 0; i--) {
    words[i] = Number(value & 0xffffffffn);
    value >>= 32n;
  }
  return words;
}

let initial: Uint32Array | null = null;

function initialWords(): Uint32Array {
  initial ??= piFractionWords(INIT_WORDS);
  return initial;
}

export class Blowfish {
  private readonly p = new Uint32Array(P_WORDS);
  private readonly s = new Uint32Array(S_BOXES * S_BOX_WORDS);

  constructor() {
    const words = initialWords();
    this.p.set(words.subarray(0, P_WORDS));
    this.s.set(words.subarray(P_WORDS));
  }

  static streamWord(data: Uint8Array, cursor: { at: number }): number {
    let word = 0;
    for (let i = 0; i < 4; i++) {
      if (cursor.at >= data.length) cursor.at = 0;
      word = ((word << 8) | data[cursor.at]) >>> 0;
      cursor.at += 1;
    }
    return word;
  }

  private f(x: number): number {
    const a = this.s[x >>> 24];
    const b = this.s[S_BOX_WORDS + ((x >>> 16) & 0xff)];
    const c = this.s[2 * S_BOX_WORDS + ((x >>> 8) & 0xff)];
    const d = this.s[3 * S_BOX_WORDS + (x & 0xff)];
    return ((((a + b) >>> 0) ^ c) + d) >>> 0;
  }

  encipher(block: Uint32Array, at = 0): void {
    let left = block[at];
    let right = block[at + 1];
    left = (left ^ this.p[0]) >>> 0;
    for (let i = 1; i <= 16; i += 2) {
      right = (right ^ this.f(left) ^ this.p[i]) >>> 0;
      left = (left ^ this.f(right) ^ this.p[i + 1]) >>> 0;
    }
    block[at] = (right ^ this.p[17]) >>> 0;
    block[at + 1] = left;
  }

  private scheduleKey(key: Uint8Array): void {
    const cursor = { at: 0 };
    for (let i = 0; i < P_WORDS; i++) this.p[i] = (this.p[i] ^ Blowfish.streamWord(key, cursor)) >>> 0;
  }

  private rekey(data: Uint8Array | null): void {
    const cursor = { at: 0 };
    const pair = new Uint32Array(2);
    const mix = (): void => {
      if (data !== null) {
        pair[0] = (pair[0] ^ Blowfish.streamWord(data, cursor)) >>> 0;
        pair[1] = (pair[1] ^ Blowfish.streamWord(data, cursor)) >>> 0;
      }
      this.encipher(pair);
    };
    for (let i = 0; i < P_WORDS; i += 2) {
      mix();
      this.p[i] = pair[0];
      this.p[i + 1] = pair[1];
    }
    for (let i = 0; i < this.s.length; i += 2) {
      mix();
      this.s[i] = pair[0];
      this.s[i + 1] = pair[1];
    }
  }

  expandState(data: Uint8Array, key: Uint8Array): void {
    this.scheduleKey(key);
    this.rekey(data);
  }

  expandZeroState(key: Uint8Array): void {
    this.scheduleKey(key);
    this.rekey(null);
  }

  static withKey(key: Uint8Array): Blowfish {
    const cipher = new Blowfish();
    cipher.expandZeroState(key);
    return cipher;
  }
}
