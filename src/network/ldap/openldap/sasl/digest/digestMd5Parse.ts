const HT = 9;
const CR = 13;
const LF = 10;
const SP = 32;
const DEL = 127;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const EQUALS = 0x3d;
const TOKEN_BREAKERS = new Set<number>([
  DEL, 0x28, 0x29, 0x3c, 0x3e, 0x40, 0x2c, 0x3b, 0x3a, 0x5c, 0x27, 0x2f, 0x5b, 0x5d, 0x3f, 0x3d, 0x7b, 0x7d,
]);

export class CBuffer {
  readonly bytes: Uint8Array;

  constructor(text: Uint8Array) {
    this.bytes = new Uint8Array(text.length + 1);
    this.bytes.set(text, 0);
  }

  at(index: number): number {
    return this.bytes[index];
  }

  set(index: number, value: number): void {
    this.bytes[index] = value;
  }

  strlen(from: number): number {
    let index = from;
    while (this.bytes[index] !== 0) index++;
    return index - from;
  }

  text(from: number): string {
    return Buffer.from(this.bytes.subarray(from, from + this.strlen(from))).toString('latin1');
  }
}

export function isLwsChar(byte: number): boolean {
  return byte === SP || byte === HT || byte === CR || byte === LF;
}

export function skipLws(buffer: CBuffer, from: number): number {
  let index = from;
  while (isLwsChar(buffer.at(index))) index++;
  return index;
}

export function skipRLws(buffer: CBuffer, from: number): number | null {
  const length = buffer.strlen(from);
  if (length === 0) return null;
  let end = from + length - 1;
  while (end > from && isLwsChar(buffer.at(end))) end--;
  if (end === from && isLwsChar(buffer.at(end))) return null;
  return end + 1;
}

function signedByte(byte: number): number {
  return byte > 127 ? byte - 256 : byte;
}

function skipToken(buffer: CBuffer, from: number): number {
  let index = from;
  while (signedByte(buffer.at(index)) > SP) {
    if (TOKEN_BREAKERS.has(buffer.at(index))) break;
    index++;
  }
  return index;
}

function unquote(buffer: CBuffer, from: number): number | null {
  if (buffer.at(from) === QUOTE) {
    const start = from + 1;
    let output = start;
    let escaped = false;
    let end = start;
    for (; buffer.at(end) !== 0; end++, output++) {
      if (escaped) {
        buffer.set(output, buffer.at(end));
        escaped = false;
      } else if (buffer.at(end) === BACKSLASH) {
        escaped = true;
        output--;
      } else if (buffer.at(end) === QUOTE) {
        break;
      } else {
        buffer.set(output, buffer.at(end));
      }
    }
    if (buffer.at(end) !== QUOTE) return null;
    while (output <= end) {
      buffer.set(output, 0);
      output++;
    }
    return end + 1;
  }
  return skipToken(buffer, from);
}

export interface Pair {
  readonly name: string | null;
  readonly value: string;
  readonly valueStart: number;
  readonly next: number;
}

export function getPair(buffer: CBuffer, from: number): Pair {
  let current = from;
  while (buffer.at(current) !== 0) {
    current = skipLws(buffer, current);
    if (buffer.at(current) === COMMA) current++;
    else break;
  }
  if (buffer.at(current) === 0) return { name: '', value: '', valueStart: current, next: from };
  const nameStart = current;
  current = skipToken(buffer, current);
  if (buffer.at(current) !== EQUALS && buffer.at(current) !== 0) {
    buffer.set(current, 0);
    current++;
  }
  current = skipLws(buffer, current);
  if (buffer.at(current) !== EQUALS) return { name: null, value: '', valueStart: current, next: from };
  buffer.set(current, 0);
  current++;
  current = skipLws(buffer, current);
  const valueStart = buffer.at(current) === QUOTE ? current + 1 : current;
  let endPair = unquote(buffer, current);
  if (endPair === null) return { name: null, value: '', valueStart, next: from };
  if (isLwsChar(buffer.at(endPair))) {
    buffer.set(endPair, 0);
    endPair++;
    endPair = skipLws(buffer, endPair);
  }
  if (buffer.at(endPair) === COMMA) {
    buffer.set(endPair, 0);
    endPair++;
  } else if (buffer.at(endPair) !== 0) {
    return { name: null, value: '', valueStart, next: from };
  }
  return { name: buffer.text(nameStart), value: buffer.text(valueStart), valueStart, next: endPair };
}

export function quote(text: string): string {
  return text.replace(/["\\]/g, (character) => `\\${character}`);
}

const MAX_UINT32_DIV_10 = 429496729;
const MAX_UINT32_MOD_10 = 5;

export function str2ul32(text: string): number | null {
  let index = 0;
  while (index < text.length && isLwsChar(text.charCodeAt(index))) index++;
  if (index >= text.length) return null;
  let value = 0;
  for (; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x30 || code > 0x39) return null;
    if (value > MAX_UINT32_DIV_10) return null;
    if (value === MAX_UINT32_DIV_10 && code - 0x30 > MAX_UINT32_MOD_10) return null;
    value = value * 10 + (code - 0x30);
  }
  return value;
}
