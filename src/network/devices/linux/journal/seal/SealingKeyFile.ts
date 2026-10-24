import { RECOMMENDED_SECPAR, RECOMMENDED_SEED_LENGTH, stateLength } from './Fsprg';

export const FSS_HEADER_LENGTH = 88;
export const DEFAULT_FSS_INTERVAL_USEC = 15 * 60 * 1_000_000;
const FSS_SIGNATURE = 'KSHHRHLP';

export interface SealingKeyFile {
  readonly machineId: string;
  readonly bootId: string;
  readonly startUsec: number;
  readonly intervalUsec: number;
  readonly secpar: number;
  readonly state: Uint8Array;
}

export type SealingKeyError = 'ENODATA' | 'EBADMSG' | 'EPROTONOSUPPORT' | 'EHOSTDOWN';

function le(value: number | bigint, length: number): string {
  let rest = BigInt(value);
  let out = '';
  for (let index = 0; index < length; index++) {
    out += String.fromCharCode(Number(rest & 0xffn));
    rest >>= 8n;
  }
  return out;
}

function readLe(text: string, at: number, length: number): number {
  let value = 0n;
  for (let index = length - 1; index >= 0; index--) value = (value << 8n) | BigInt(text.charCodeAt(at + index) & 0xff);
  return Number(value);
}

function idBytes(hex: string): string {
  return (hex.match(/../g) ?? []).map((pair) => String.fromCharCode(parseInt(pair, 16))).join('');
}

function idHex(bytes: string): string {
  return [...bytes].map((character) => character.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

function stateText(state: Uint8Array): string {
  let out = '';
  for (const byte of state) out += String.fromCharCode(byte);
  return out;
}

export function encodeSealingKey(file: SealingKeyFile): string {
  return FSS_SIGNATURE + le(0, 4) + le(0, 4) + idBytes(file.machineId) + idBytes(file.bootId) + le(FSS_HEADER_LENGTH, 8)
    + le(file.startUsec, 8) + le(file.intervalUsec, 8) + le(file.secpar, 2) + le(0, 6) + le(file.state.length, 8) + stateText(file.state);
}

export function decodeSealingKey(text: string, machineId: string): SealingKeyFile | SealingKeyError {
  if (text.length < FSS_HEADER_LENGTH) return 'ENODATA';
  if (!text.startsWith(FSS_SIGNATURE)) return 'EBADMSG';
  if (readLe(text, 12, 4) !== 0) return 'EPROTONOSUPPORT';
  const headerSize = readLe(text, 48, 8);
  if (headerSize < FSS_HEADER_LENGTH) return 'EBADMSG';
  const secpar = readLe(text, 72, 2);
  const stateSize = readLe(text, 80, 8);
  if (secpar % 16 !== 0 || secpar < 16 || secpar > 16384 || stateSize !== stateLength(secpar)) return 'EBADMSG';
  if (text.length < headerSize + stateSize) return 'ENODATA';
  if (idHex(text.slice(16, 32)) !== machineId) return 'EHOSTDOWN';
  const startUsec = readLe(text, 56, 8);
  const intervalUsec = readLe(text, 64, 8);
  if (startUsec <= 0 || intervalUsec <= 0) return 'EBADMSG';
  const state = Uint8Array.from(text.slice(headerSize, headerSize + stateSize), (character) => character.charCodeAt(0));
  return { machineId, bootId: idHex(text.slice(32, 48)), startUsec, intervalUsec, secpar, state };
}

export function formatVerificationKey(seed: Uint8Array, epochNumber: number, intervalUsec: number): string {
  let out = '';
  seed.forEach((byte, index) => {
    if (index > 0 && index % 3 === 0) out += '-';
    out += byte.toString(16).padStart(2, '0');
  });
  return `${out}/${epochNumber.toString(16)}-${intervalUsec.toString(16)}`;
}

export interface VerificationKey {
  readonly seed: Uint8Array;
  readonly startUsec: number;
  readonly intervalUsec: number;
}

export function parseVerificationKey(key: string): VerificationKey | null {
  const seed = new Uint8Array(RECOMMENDED_SEED_LENGTH);
  let at = 0;
  for (let index = 0; index < seed.length; index++) {
    while (key[at] === '-') at++;
    const pair = key.slice(at, at + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) return null;
    seed[index] = parseInt(pair, 16);
    at += 2;
  }
  if (key[at] !== '/') return null;
  const rest = /^([0-9a-fA-F]+)-([0-9a-fA-F]+)/.exec(key.slice(at + 1));
  if (rest === null) return null;
  const start = parseInt(rest[1], 16);
  const interval = parseInt(rest[2], 16);
  return { seed, startUsec: start * interval, intervalUsec: interval };
}

export { RECOMMENDED_SECPAR };
