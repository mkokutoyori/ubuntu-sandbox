import { bytesToFileText, fileTextToBytes } from '@/crypto/encoding';
import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { Streams, docsResult, quoteLocale, quotef, readFailureText, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const COMMON_OPTIONS: readonly LongOption[] = [
  { name: 'decode', letter: 'd', takesArgument: false },
  { name: 'ignore-garbage', letter: 'i', takesArgument: false },
  { name: 'wrap', letter: 'w', takesArgument: true },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

interface Encoding {
  readonly alphabet: string;
  readonly bits: number;
  readonly padded: boolean;
  readonly blockChars: number;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const Z85_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#';

const ENCODINGS: Readonly<Record<string, Encoding>> = {
  base64: { alphabet: BASE64_ALPHABET, bits: 6, padded: true, blockChars: 4 },
  base64url: { alphabet: `${BASE64_ALPHABET.slice(0, 62)}-_`, bits: 6, padded: true, blockChars: 4 },
  base32: { alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', bits: 5, padded: true, blockChars: 8 },
  base32hex: { alphabet: '0123456789ABCDEFGHIJKLMNOPQRSTUV', bits: 5, padded: true, blockChars: 8 },
  base16: { alphabet: '0123456789ABCDEF', bits: 4, padded: false, blockChars: 2 },
  base2msbf: { alphabet: '01', bits: 1, padded: false, blockChars: 8 },
  base2lsbf: { alphabet: '01', bits: 1, padded: false, blockChars: 8 },
  z85: { alphabet: Z85_ALPHABET, bits: 0, padded: false, blockChars: 5 },
};

const BASENC_TYPES = ['base64', 'base64url', 'base32', 'base32hex', 'base16', 'base2msbf', 'base2lsbf', 'z85'];
const BASENC_LETTERS: Readonly<Record<string, string>> = { '1': 'base64', '2': 'base64url', '3': 'base32', '4': 'base32hex', '5': 'base16', '6': 'base2msbf', '7': 'base2lsbf', '8': 'z85' };

function encodeBits(bytes: Uint8Array, encoding: Encoding, lsbFirst: boolean): string {
  let out = '';
  let accumulator = 0;
  let held = 0;
  for (const byte of bytes) {
    if (lsbFirst) {
      for (let bit = 0; bit < 8; bit++) out += (byte >> bit) & 1;
      continue;
    }
    accumulator = (accumulator << 8) | byte;
    held += 8;
    while (held >= encoding.bits) {
      held -= encoding.bits;
      out += encoding.alphabet[(accumulator >> held) & ((1 << encoding.bits) - 1)];
    }
    accumulator &= (1 << held) - 1;
  }
  if (held > 0) out += encoding.alphabet[(accumulator << (encoding.bits - held)) & ((1 << encoding.bits) - 1)];
  if (encoding.padded) while (out.length % encoding.blockChars !== 0) out += '=';
  return out;
}

function encodeZ85(bytes: Uint8Array): string | null {
  if (bytes.length % 4 !== 0) return null;
  let out = '';
  for (let at = 0; at < bytes.length; at += 4) {
    let value = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
    let chunk = '';
    for (let digit = 0; digit < 5; digit++) { chunk = Z85_ALPHABET[value % 85] + chunk; value = Math.floor(value / 85); }
    out += chunk;
  }
  return out;
}

function decodeBits(text: string, type: string, encoding: Encoding, ignoreGarbage: boolean): { bytes: number[]; failed: boolean; reason?: string } {
  const out: number[] = [];
  const lsbFirst = type === 'base2lsbf';
  const alphabet = encoding.alphabet;
  let pending = '';
  let padding = 0;
  let failed = false;
  let midStream = false;
  const flush = (): void => {
    if (pending.length === 0) return;
    if (encoding.bits === 1) {
      const bits = pending.split('').map(Number);
      if (bits.length < 8) return;
      let value = 0;
      for (let index = 0; index < 8; index++) value |= bits[index] << (lsbFirst ? index : 7 - index);
      out.push(value);
      return;
    }
    const count = Math.floor((pending.length * encoding.bits) / 8);
    let accumulator = 0;
    let held = 0;
    const bytes: number[] = [];
    for (const ch of pending) {
      accumulator = (accumulator << encoding.bits) | alphabet.indexOf(ch);
      held += encoding.bits;
      if (held >= 8) { held -= 8; bytes.push((accumulator >> held) & 0xff); accumulator &= (1 << held) - 1; }
    }
    out.push(...bytes.slice(0, count));
  };
  for (const ch of text) {
    if (ch === '\n') continue;
    if (ch === '=' && encoding.padded) { padding += 1; continue; }
    if (!alphabet.includes(ch)) {
      if (ignoreGarbage) continue;
      failed = true;
      midStream = true;
      break;
    }
    if (padding > 0) {
      const needed = encoding.blockChars - pending.length;
      if (padding !== needed) { failed = true; midStream = true; break; }
      flush();
      pending = '';
      padding = 0;
    }
    pending += ch;
    if (pending.length === encoding.blockChars) { flush(); pending = ''; }
  }
  if (!failed && pending.length > 0) {
    const leftover = (pending.length * encoding.bits) % 8;
    if (encoding.padded) {
      const needed = encoding.blockChars - pending.length;
      if (leftover >= encoding.bits || padding !== needed) { failed = true; midStream = padding >= needed; }
    } else {
      failed = true;
    }
  } else if (!failed && pending.length === 0 && padding > 0) {
    failed = true;
  }
  if (!failed || midStream || encoding.bits === 6) flush();
  return { bytes: out, failed };
}

function decodeZ85(text: string, ignoreGarbage: boolean): { bytes: number[]; failed: boolean } {
  const symbols = [...text].filter((ch) => ch !== '\n' && (!ignoreGarbage || Z85_ALPHABET.includes(ch)));
  if (symbols.some((ch) => !Z85_ALPHABET.includes(ch))) return { bytes: [], failed: true };
  const bytes: number[] = [];
  for (let at = 0; at + 5 <= symbols.length; at += 5) {
    let value = 0;
    for (let digit = 0; digit < 5; digit++) value = value * 85 + Z85_ALPHABET.indexOf(symbols[at + digit]);
    bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }
  return { bytes, failed: symbols.length % 5 !== 0 };
}

export function runBaseEncoding(program: string, args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  let type = program === 'basenc' ? '' : program;
  let decodeMode = false;
  let ignoreGarbage = false;
  let wrap = 76;
  const operands: string[] = [];
  const streams = new Streams();
  const long: LongOption[] = program === 'basenc'
    ? [...COMMON_OPTIONS, ...BASENC_TYPES.map((name, index) => ({ name, letter: String(index + 1), takesArgument: false }))]
    : [...COMMON_OPTIONS];
  for (const item of shortOptions(args, 'diw:', long)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure(program, getoptDiagnostic(program, item));
    switch (item.letter) {
      case 'H': return docsResult(program, 'help');
      case 'V': return docsResult(program, 'version');
      case 'd': decodeMode = true; break;
      case 'i': ignoreGarbage = true; break;
      case 'w': {
        const text = item.argument ?? '';
        if (!/^\d+$/.test(text)) {
          streams.diagnostic(`${program}: invalid wrap size: ${quoteLocale(text)}`);
          streams.exitCode = 1;
          return streams.result();
        }
        wrap = Number(text);
        break;
      }
      default:
        if (BASENC_LETTERS[item.letter] !== undefined) type = BASENC_LETTERS[item.letter];
    }
  }
  if (type === '') return usageFailure(program, `${program}: missing encoding type`);
  if (operands.length > 1) return usageFailure(program, `${program}: extra operand ${quoteLocale(operands[1])}`);
  const encoding = ENCODINGS[type];
  const name = operands[0] ?? '-';
  const read = name === '-' ? { kind: 'ok' as const, text: io.stdin ?? '' } : io.read(name);
  if (read.kind !== 'ok') {
    streams.diagnostic(`${program}: ${quotef(name)}: ${readFailureText(read)}`);
    streams.exitCode = 1;
    return streams.result();
  }
  if (decodeMode) {
    const result = type === 'z85' ? decodeZ85(read.text, ignoreGarbage) : decodeBits(read.text, type, encoding, ignoreGarbage);
    streams.stdout(bytesToFileText(Uint8Array.from(result.bytes)));
    if (result.failed) {
      streams.diagnostic(`${program}: invalid input`);
      streams.exitCode = 1;
    }
    return streams.result();
  }
  const bytes = fileTextToBytes(read.text);
  const encoded = type === 'z85' ? encodeZ85(bytes) : encodeBits(bytes, encoding, type === 'base2lsbf');
  if (encoded === null) {
    streams.diagnostic(`${program}: invalid input (length must be multiple of 4 characters)`);
    streams.exitCode = 1;
    return streams.result();
  }
  if (encoded === '') return streams.result();
  if (wrap === 0) { streams.stdout(encoded); return streams.result(); }
  const lines: string[] = [];
  for (let at = 0; at < encoded.length; at += wrap) lines.push(encoded.slice(at, at + wrap));
  streams.stdout(`${lines.join('\n')}\n`);
  return streams.result();
}

export function runBase64(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  return runBaseEncoding('base64', args, io);
}
