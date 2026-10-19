import { isProbablePrime } from '@/crypto/rsa';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

export const MODULI_TYPE_SAFE = 2;
export const MODULI_TYPE_SOPHIE_GERMAIN = 4;
export const MODULI_TESTS_COMPOSITE = 0x01;
export const MODULI_TESTS_SIEVE = 0x02;
export const MODULI_TESTS_MILLER_RABIN = 0x04;
export const QSIZE_MINIMUM = 511;
export const TEST_MAXIMUM = 1 << 16;
export const TEST_MINIMUM = QSIZE_MINIMUM + 1;
export const LARGE_MINIMUM_MEGABYTES = 8;
export const LARGE_MAXIMUM_MEGABYTES = 127;
export const TRIAL_MINIMUM = 4;
export const DEFAULT_TRIALS = 100;

const SHIFT_WORD = 5;
const SHIFT_BYTE = 2;
const SHIFT_MEGAWORD = 18;
const TEST_POWER = 3;
const TINY_NUMBER = 1 << 16;
const SMALL_MAXIMUM = 0xffffffff;
const MAXIMUM_LARGE_WORDS = 1 << 16;
const SIEVE_PRIME_LIMIT = 1 << 20;
const WORD_BITS = 32;

export interface WindowPlan {
  readonly largewords: number;
  readonly notices: readonly string[];
}

export function planWindow(power: number, memoryMegabytes: number): WindowPlan {
  const notices: string[] = [];
  const need = Math.floor((power * power) / (1 << (SHIFT_WORD - TEST_POWER)));
  let largewords = need;
  const memoryWords = memoryMegabytes * (1 << SHIFT_MEGAWORD);
  if (need <= memoryWords) {
    notices.push(`Increased memory: ${memoryMegabytes} MB; need ${need * (1 << SHIFT_BYTE)} bytes`);
    largewords = memoryWords;
  } else if (memoryMegabytes > 0) {
    notices.push(`Decreased memory: ${memoryMegabytes} MB; want ${need * (1 << SHIFT_BYTE)} bytes`);
    largewords = memoryWords;
  }
  return { largewords: Math.min(largewords, MAXIMUM_LARGE_WORDS), notices };
}

export interface SieveOutcome {
  readonly survivors: readonly bigint[];
  readonly tries: number;
  readonly numbers: number;
}

class BitSet {
  private readonly words: Uint32Array;

  constructor(bits: number) {
    this.words = new Uint32Array(Math.ceil(bits / WORD_BITS));
  }

  set(bit: number): void {
    this.words[bit >>> SHIFT_WORD] |= 1 << (bit & 31);
  }

  test(bit: number): boolean {
    return (this.words[bit >>> SHIFT_WORD] & (1 << (bit & 31))) !== 0;
  }

  clear(): void {
    this.words.fill(0);
  }
}

export function sieveCandidates(base: bigint, largewords: number): SieveOutcome {
  const largebits = largewords * WORD_BITS;
  const large = new BitSet(largebits);
  let tries = 0;

  const sieveLarge = (s: number): void => {
    tries += 1;
    const remainder = Number(base % BigInt(s));
    let u = remainder === 0 ? 0 : s - remainder;
    if (u < largebits * 2) {
      if (u & 1) u += s;
      for (u = Math.floor(u / 2); u < largebits; u += s) large.set(u);
    }
    const shifted = (2 * remainder + 1) % s;
    u = shifted === 0 ? 0 : s - shifted;
    if (u < largebits * 4) {
      while (u & 3) {
        if (SMALL_MAXIMUM - u < s) return;
        u += s;
      }
      for (u = Math.floor(u / 4); u < largebits; u += s) large.set(u);
    }
  };

  const tinybits = (TINY_NUMBER >> 6) << SHIFT_WORD;
  const tiny = new BitSet(tinybits);
  for (let i = 0; i < tinybits; i++) {
    if (tiny.test(i)) continue;
    const t = 2 * i + 3;
    for (let j = i + t; j < tinybits; j += t) tiny.set(j);
    sieveLarge(t);
  }

  const smallbits = tinybits;
  const small = new BitSet(smallbits);
  for (let smallbase = TINY_NUMBER + 3; smallbase < SIEVE_PRIME_LIMIT; smallbase += TINY_NUMBER) {
    for (let i = 0; i < tinybits; i++) {
      if (tiny.test(i)) continue;
      const t = 2 * i + 3;
      const r = smallbase % t;
      let s = r === 0 ? 0 : t - r;
      if (s & 1) s += t;
      for (s = Math.floor(s / 2); s < smallbits; s += t) small.set(s);
    }
    for (let i = 0; i < smallbits; i++) {
      if (small.test(i)) continue;
      sieveLarge(2 * i + smallbase);
    }
    small.clear();
  }

  const survivors: bigint[] = [];
  for (let j = 0; j < largebits; j++) {
    if (!large.test(j)) survivors.push(base + BigInt(2 * j));
  }
  return { survivors, tries, numbers: largebits * 2 };
}

export function startingPoint(power: number, random: (count: number) => Uint8Array): bigint {
  const bytes = random(Math.ceil(power / 8));
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  value &= (1n << BigInt(power)) - 1n;
  value |= 3n << BigInt(power - 2);
  return value | 1n;
}

export function moduliLine(
  seconds: number, type: number, tests: number, tries: number, size: number, generator: number, modulus: bigint,
): string {
  const at = new Date(seconds * 1000);
  const two = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${at.getUTCFullYear()}${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}${two(at.getUTCHours())}${two(at.getUTCMinutes())}${two(at.getUTCSeconds())}`;
  return `${stamp} ${type} ${tests} ${tries} ${size} ${generator.toString(16)} ${modulus.toString(16).toUpperCase()}`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function ctimeText(ms: number, offsetMinutes: number): string {
  const local = new Date(ms + offsetMinutes * 60_000);
  const two = (value: number): string => String(value).padStart(2, '0');
  const day = padToWidth(String(local.getUTCDate()), 2, 'right');
  return `${DAYS[local.getUTCDay()]} ${MONTHS[local.getUTCMonth()]} ${day} ${two(local.getUTCHours())}:${two(local.getUTCMinutes())}:${two(local.getUTCSeconds())} ${local.getUTCFullYear()}`;
}

export interface CandidateLine {
  readonly type: number;
  readonly tests: number;
  readonly tries: number;
  readonly size: number;
  readonly generator: number;
  readonly modulus: bigint;
}

export function parseCandidateLine(line: string): CandidateLine | null {
  if (line.length < 14) return null;
  const fields = line.slice(14).trim().split(/\s+/);
  if (fields.length < 6) return null;
  const [type, tests, tries, size] = fields.slice(0, 4).map((field) => Number.parseInt(field, 10));
  const generator = Number.parseInt(fields[4], 16);
  if ([type, tests, tries, size, generator].some((value) => Number.isNaN(value))) return null;
  if (!/^[0-9a-fA-F]+$/.test(fields[5])) return null;
  return { type, tests, tries, size, generator, modulus: BigInt(`0x${fields[5]}`) };
}

export interface ScreenedPrime {
  readonly tests: number;
  readonly tries: number;
  readonly size: number;
  readonly generator: number;
  readonly modulus: bigint;
}

export function screenCandidate(
  candidate: CandidateLine, trials: number, wantedGenerator: number,
): { readonly counted: boolean; readonly prime: ScreenedPrime | null } {
  if ((candidate.tests & MODULI_TESTS_COMPOSITE) !== 0) return { counted: false, prime: null };
  let p: bigint;
  let q: bigint;
  let size = candidate.size;
  let generator = candidate.generator;
  if (candidate.type === MODULI_TYPE_SOPHIE_GERMAIN) {
    q = candidate.modulus;
    p = (q << 1n) + 1n;
    size += 1;
    generator = 0;
  } else {
    p = candidate.modulus;
    q = p >> 1n;
  }
  if (p.toString(2).length !== size + 1) return { counted: false, prime: null };
  if (size < QSIZE_MINIMUM) return { counted: false, prime: null };
  const tries = (candidate.tests & MODULI_TESTS_MILLER_RABIN) !== 0 ? candidate.tries + trials : trials;
  if (generator === 0) {
    if (p % 24n === 11n) generator = 2;
    else if (p % 10n === 3n || p % 10n === 7n) generator = 5;
  }
  if (wantedGenerator > 0 && wantedGenerator !== generator) return { counted: false, prime: null };
  if (generator === 0) return { counted: false, prime: null };
  if (!isProbablePrime(q, 1)) return { counted: true, prime: null };
  if (!isProbablePrime(p, trials)) return { counted: true, prime: null };
  if (!isProbablePrime(q, trials - 1)) return { counted: true, prime: null };
  return { counted: true, prime: { tests: candidate.tests | MODULI_TESTS_MILLER_RABIN, tries, size, generator, modulus: p } };
}
