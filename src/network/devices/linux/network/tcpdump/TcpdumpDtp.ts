import { nullPaddedText } from './TcpdumpHex';

type EtherName = (mac: string) => string;

const HEADER_BYTES = 1;
const TLV_HEADER_BYTES = 4;
const INVALID = ' (invalid)';
const TRUNCATED = ' [|dtp]';

const TLV_NAMES: Readonly<Record<number, string>> = { 1: 'Domain', 2: 'Status', 3: 'DTP type', 4: 'Neighbor' };

class Truncated extends Error {}

function u8(bytes: readonly number[], at: number): number {
  if (at >= bytes.length) throw new Truncated();
  return bytes[at];
}

function u16(bytes: readonly number[], at: number): number {
  return (u8(bytes, at) << 8) | u8(bytes, at + 1);
}

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0');
}

function macText(bytes: readonly number[], at: number): string {
  u8(bytes, at + 5);
  return [0, 1, 2, 3, 4, 5].map((index) => hex(bytes[at + index], 2)).join(':');
}

function print(bytes: readonly number[], length: number, verbose: number, ether: EtherName): string {
  if (length < HEADER_BYTES) return `[zero packet length]${INVALID}`;
  let text = `DTPv${u8(bytes, 0)}, length ${length}`;
  if (verbose < 1) return text;
  let at = HEADER_BYTES;
  let remaining = length - HEADER_BYTES;
  while (remaining > 0) {
    if (remaining < TLV_HEADER_BYTES) return `${text}[${remaining} bytes remaining]${INVALID}`;
    const type = u16(bytes, at);
    const tlvLength = u16(bytes, at + 2);
    if (type === 0) return text;
    text += `\n\t${TLV_NAMES[type] ?? 'Unknown'} (0x${hex(type, 4)}) TLV, length ${tlvLength}`;
    if (tlvLength < TLV_HEADER_BYTES || tlvLength > remaining) return `${text}[invalid TLV length ${tlvLength}]${INVALID}`;
    const valueAt = at + TLV_HEADER_BYTES;
    const valueLength = tlvLength - TLV_HEADER_BYTES;
    if (type === 1) {
      text += ', ';
      for (let index = 0; index < valueLength; index++) {
        const byte = u8(bytes, valueAt + index);
        if (byte === 0) break;
        text += nullPaddedText([byte]);
      }
    } else if (type === 2 || type === 3) {
      if (tlvLength !== 5) return text + INVALID;
      text += `, 0x${u8(bytes, valueAt).toString(16)}`;
    } else if (type === 4) {
      if (tlvLength !== 10) return text + INVALID;
      text += `, ${ether(macText(bytes, valueAt))}`;
    } else {
      u8(bytes, at + tlvLength - 1);
    }
    at += tlvLength;
    remaining -= tlvLength;
  }
  return text;
}

export function dtpText(payload: readonly number[], length: number, verbose: number, ether: EtherName): string {
  try {
    return print(payload, length, verbose, ether);
  } catch (error) {
    if (error instanceof Truncated) return TRUNCATED;
    throw error;
  }
}
