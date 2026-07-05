/**
 * TFTP (RFC 1350 §5) — byte-level wire codec. Every packet starts with a
 * 2-byte big-endian opcode; strings (filename/mode/option name/option
 * value/error message) are null-terminated ASCII, exactly as the RFC
 * specifies — no length prefixes anywhere.
 */
import type { TftpPacket, TftpMode, TftpOptions } from './types';

const OPCODE_CODE: Readonly<Record<TftpPacket['opcode'], number>> = {
  RRQ: 1, WRQ: 2, DATA: 3, ACK: 4, ERROR: 5, OACK: 6,
};
const OPCODE_FROM_CODE: Readonly<Record<number, TftpPacket['opcode']>> = {
  1: 'RRQ', 2: 'WRQ', 3: 'DATA', 4: 'ACK', 5: 'ERROR', 6: 'OACK',
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function writeUint16BE(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function encodeCString(s: string): Uint8Array {
  const body = encoder.encode(s);
  const out = new Uint8Array(body.length + 1);
  out.set(body, 0);
  out[body.length] = 0;
  return out;
}

/** Reads one null-terminated string starting at `offset`; throws if no terminator is found (truncated packet). */
function readCString(bytes: Uint8Array, offset: number): { value: string; next: number } {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end++;
  if (end >= bytes.length) throw new Error('tftp: unterminated string');
  return { value: decoder.decode(bytes.slice(offset, end)), next: end + 1 };
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

function encodeOptions(options: TftpOptions | undefined): Uint8Array[] {
  if (!options) return [];
  const parts: Uint8Array[] = [];
  if (options.blksize !== undefined) parts.push(encodeCString('blksize'), encodeCString(String(options.blksize)));
  if (options.timeout !== undefined) parts.push(encodeCString('timeout'), encodeCString(String(options.timeout)));
  if (options.tsize !== undefined) parts.push(encodeCString('tsize'), encodeCString(String(options.tsize)));
  return parts;
}

function readOptions(bytes: Uint8Array, startOffset: number): TftpOptions {
  const options: Record<string, number> = {};
  let offset = startOffset;
  while (offset < bytes.length) {
    const { value: key, next: n1 } = readCString(bytes, offset);
    const { value: val, next: n2 } = readCString(bytes, n1);
    const num = parseInt(val, 10);
    if (key && !Number.isNaN(num)) options[key.toLowerCase()] = num;
    offset = n2;
  }
  return options;
}

export function encodeTftpPacket(pkt: TftpPacket): Uint8Array {
  switch (pkt.opcode) {
    case 'RRQ':
    case 'WRQ':
      return concatBytes([
        writeUint16BE(OPCODE_CODE[pkt.opcode]), encodeCString(pkt.filename), encodeCString(pkt.mode),
        ...encodeOptions(pkt.options),
      ]);
    case 'DATA':
      return concatBytes([writeUint16BE(OPCODE_CODE.DATA), writeUint16BE(pkt.block), pkt.data]);
    case 'ACK':
      return concatBytes([writeUint16BE(OPCODE_CODE.ACK), writeUint16BE(pkt.block)]);
    case 'ERROR':
      return concatBytes([writeUint16BE(OPCODE_CODE.ERROR), writeUint16BE(pkt.code), encodeCString(pkt.message)]);
    case 'OACK':
      return concatBytes([writeUint16BE(OPCODE_CODE.OACK), ...encodeOptions(pkt.options)]);
  }
}

export function decodeTftpPacket(bytes: Uint8Array): TftpPacket | null {
  if (bytes.length < 2) return null;
  const opcode = OPCODE_FROM_CODE[readUint16BE(bytes, 0)];
  if (!opcode) return null;
  try {
    switch (opcode) {
      case 'RRQ':
      case 'WRQ': {
        const { value: filename, next: n1 } = readCString(bytes, 2);
        const { value: mode, next: n2 } = readCString(bytes, n1);
        const options = readOptions(bytes, n2);
        return {
          opcode, filename, mode: mode.toLowerCase() as TftpMode,
          options: Object.keys(options).length > 0 ? options : undefined,
        };
      }
      case 'DATA':
        if (bytes.length < 4) return null;
        return { opcode: 'DATA', block: readUint16BE(bytes, 2), data: bytes.slice(4) };
      case 'ACK':
        if (bytes.length < 4) return null;
        return { opcode: 'ACK', block: readUint16BE(bytes, 2) };
      case 'ERROR': {
        if (bytes.length < 4) return null;
        const code = readUint16BE(bytes, 2);
        const { value: message } = readCString(bytes, 4);
        return { opcode: 'ERROR', code, message };
      }
      case 'OACK':
        return { opcode: 'OACK', options: readOptions(bytes, 2) };
    }
  } catch {
    return null;
  }
}
