import { sha256 } from '@/crypto/hash/sha256';

export const RECOMMENDED_SECPAR = 1536;
export const RECOMMENDED_SEED_LENGTH = 96 / 8;

const GENERATE_P = 1;
const GENERATE_Q = 2;
const GENERATE_X = 3;
const SMALL_PRIMES = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n, 47n, 53n, 59n, 61n, 67n, 71n, 73n, 79n, 83n, 89n, 97n];
const MILLER_RABIN_BASES = SMALL_PRIMES.slice(0, 20);

function validate(secpar: number): void {
  if (secpar % 16 !== 0 || secpar < 16 || secpar > 16384) throw new RangeError('invalid security parameter');
}

export function masterKeyLength(secpar: number): number {
  validate(secpar);
  return 2 + (2 * (secpar / 2)) / 8;
}

export function masterPublicKeyLength(secpar: number): number {
  validate(secpar);
  return 2 + secpar / 8;
}

export function stateLength(secpar: number): number {
  validate(secpar);
  return 2 + (2 * secpar) / 8 + 8;
}

function toBig(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function fromBig(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let rest = value;
  for (let index = length - 1; index >= 0; index--) {
    out[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  if (rest !== 0n) throw new RangeError('integer does not fit');
  return out;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let power = base % modulus;
  let rest = exponent;
  while (rest > 0n) {
    if ((rest & 1n) === 1n) result = (result * power) % modulus;
    power = (power * power) % modulus;
    rest >>= 1n;
  }
  return result;
}

function modInverse(value: bigint, modulus: bigint): bigint {
  let [oldR, r] = [value % modulus, modulus];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const quotient = oldR / r;
    [oldR, r] = [r, oldR - quotient * r];
    [oldS, s] = [s, oldS - quotient * s];
  }
  return ((oldS % modulus) + modulus) % modulus;
}

function isProbablePrime(candidate: bigint): boolean {
  if (candidate < 2n) return false;
  for (const prime of SMALL_PRIMES) {
    if (candidate === prime) return true;
    if (candidate % prime === 0n) return false;
  }
  let d = candidate - 1n;
  let twos = 0;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    twos++;
  }
  const minusOne = candidate - 1n;
  for (const base of MILLER_RABIN_BASES) {
    let x = modPow(base, d, candidate);
    if (x === 1n || x === minusOne) continue;
    let witness = true;
    for (let round = 1; round < twos; round++) {
      x = (x * x) % candidate;
      if (x === minusOne) {
        witness = false;
        break;
      }
    }
    if (witness) return false;
  }
  return true;
}

function counterBytes(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

export function deterministicRandom(length: number, seed: Uint8Array, index: number): Uint8Array {
  const out = new Uint8Array(length);
  const prefix = new Uint8Array(seed.length + 4);
  prefix.set(seed);
  prefix.set(counterBytes(index), seed.length);
  let written = 0;
  for (let counter = 0; written < length; counter++) {
    const block = new Uint8Array(prefix.length + 4);
    block.set(prefix);
    block.set(counterBytes(counter), prefix.length);
    const digest = sha256(block);
    const take = Math.min(length - written, digest.length);
    out.set(digest.subarray(0, take), written);
    written += take;
  }
  return out;
}

function generatePrime(bits: number, seed: Uint8Array, index: number): bigint {
  const bytes = deterministicRandom(bits / 8, seed, index);
  bytes[0] |= 0xc0;
  bytes[bytes.length - 1] |= 0x03;
  let prime = toBig(bytes);
  while (!isProbablePrime(prime)) prime += 4n;
  return prime;
}

function generateSquare(modulus: bigint, seed: Uint8Array, index: number, secpar: number): bigint {
  const bytes = deterministicRandom(secpar / 8, seed, index);
  bytes[0] &= 0x7f;
  const x = toBig(bytes);
  return (x * x) % modulus;
}

function storeSecpar(secpar: number): Uint8Array {
  const value = secpar / 16 - 1;
  return Uint8Array.of((value >> 8) & 0xff, value & 0xff);
}

function readSecpar(buffer: Uint8Array): number {
  return 16 * (((buffer[0] << 8) | buffer[1]) + 1);
}

export interface MasterKey {
  readonly secpar: number;
  readonly p: bigint;
  readonly q: bigint;
}

const MASTER_KEY_MEMORY = 16;
const masterKeys = new Map<string, MasterKey>();

export function generateMasterKey(seed: Uint8Array, secpar = RECOMMENDED_SECPAR): MasterKey {
  validate(secpar);
  const memoKey = `${secpar}:${Array.from(seed, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  const known = masterKeys.get(memoKey);
  if (known !== undefined) return known;
  const master = { secpar, p: generatePrime(secpar / 2, seed, GENERATE_P), q: generatePrime(secpar / 2, seed, GENERATE_Q) };
  if (masterKeys.size >= MASTER_KEY_MEMORY) masterKeys.delete(masterKeys.keys().next().value as string);
  masterKeys.set(memoKey, master);
  return master;
}

export function masterPublicKey(master: MasterKey): Uint8Array {
  const out = new Uint8Array(masterPublicKeyLength(master.secpar));
  out.set(storeSecpar(master.secpar));
  out.set(fromBig(master.p * master.q, master.secpar / 8), 2);
  return out;
}

export function generateState0(publicKey: Uint8Array, seed: Uint8Array): Uint8Array {
  const secpar = readSecpar(publicKey);
  const n = toBig(publicKey.subarray(2, 2 + secpar / 8));
  const x = generateSquare(n, seed, GENERATE_X, secpar);
  const state = new Uint8Array(stateLength(secpar));
  state.set(publicKey.subarray(0, 2 + secpar / 8));
  state.set(fromBig(x, secpar / 8), 2 + secpar / 8);
  return state;
}

export function stateSecpar(state: Uint8Array): number {
  return readSecpar(state);
}

export function epochOf(state: Uint8Array): number {
  const secpar = readSecpar(state);
  const at = 2 + (2 * secpar) / 8;
  let value = 0n;
  for (let index = 0; index < 8; index++) value = (value << 8n) | BigInt(state[at + index]);
  return Number(value);
}

export function evolve(state: Uint8Array): void {
  const secpar = readSecpar(state);
  const n = toBig(state.subarray(2, 2 + secpar / 8));
  const x = toBig(state.subarray(2 + secpar / 8, 2 + (2 * secpar) / 8));
  const next = (x * x) % n;
  state.set(fromBig(next, secpar / 8), 2 + secpar / 8);
  const epoch = BigInt(epochOf(state)) + 1n;
  state.set(fromBig(epoch, 8), 2 + (2 * secpar) / 8);
}

function twoPowModPhi(exponent: number, prime: bigint): bigint {
  const phi = prime - 1n;
  let result = 1n;
  const bits = exponent.toString(2);
  for (const bit of bits) {
    result = (result * result) % phi;
    if (bit === '1') {
      result += result;
      if (result >= phi) result -= phi;
    }
  }
  return result;
}

export function seek(epoch: number, master: MasterKey, seed: Uint8Array): Uint8Array {
  const { secpar, p, q } = master;
  const n = p * q;
  const x = generateSquare(n, seed, GENERATE_X, secpar);
  const xp = modPow(x % p, twoPowModPhi(epoch, p), p);
  const xq = modPow(x % q, twoPowModPhi(epoch, q), q);
  const a = ((((xq - xp) % q) + q) % q * modInverse(p, q)) % q;
  const xm = p * a + xp;
  const state = new Uint8Array(stateLength(secpar));
  state.set(storeSecpar(secpar));
  state.set(fromBig(n, secpar / 8), 2);
  state.set(fromBig(xm, secpar / 8), 2 + secpar / 8);
  state.set(fromBig(BigInt(epoch), 8), 2 + (2 * secpar) / 8);
  return state;
}

export function stateKey(state: Uint8Array, length: number, index: number): Uint8Array {
  const secpar = readSecpar(state);
  return deterministicRandom(length, state.subarray(2, 2 + (2 * secpar) / 8 + 8), index);
}
