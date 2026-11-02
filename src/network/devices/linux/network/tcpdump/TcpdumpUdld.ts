import { nullPaddedText, printableByte } from './TcpdumpHex';

const HEADER_BYTES = 4;
const TLV_HEADER_BYTES = 4;
const INVALID = ' (invalid)';
const TRUNCATED = ' [|udld]';
const VERSION_SHIFT = 5;
const OPCODE_MASK = 0x1f;

const CODES: Readonly<Record<number, string>> = { 0: 'Reserved', 1: 'Probe message', 2: 'Echo message', 3: 'Flush message' };
const TLV_NAMES: Readonly<Record<number, string>> = {
  1: 'Device-ID TLV', 2: 'Port-ID TLV', 3: 'Echo TLV', 4: 'Message Interval TLV', 5: 'Timeout Interval TLV', 6: 'Device Name TLV', 7: 'Sequence Number TLV',
};
const FLAG_NAMES: readonly string[] = ['RT', 'RSY', 'MBZ-2', 'MBZ-3', 'MBZ-4', 'MBZ-5', 'MBZ-6', 'MBZ-7'];

class Truncated extends Error {}

class Invalid extends Error {
  constructor(readonly at: number, readonly remaining: number) {
    super('invalid');
  }
}

function u8(bytes: readonly number[], at: number): number {
  if (at >= bytes.length) throw new Truncated();
  return bytes[at];
}

function u16(bytes: readonly number[], at: number): number {
  return (u8(bytes, at) << 8) | u8(bytes, at + 1);
}

function u32(bytes: readonly number[], at: number): number {
  return ((u8(bytes, at) << 24) | (u8(bytes, at + 1) << 16) | (u8(bytes, at + 2) << 8) | u8(bytes, at + 3)) >>> 0;
}

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0');
}

function check(bytes: readonly number[], at: number, length: number): void {
  if (length > 0) u8(bytes, at + length - 1);
}

function flagText(flags: number): string {
  const names = FLAG_NAMES.filter((_, bit) => (flags & (1 << bit)) !== 0);
  return names.length === 0 ? 'none' : names.join(', ');
}

function print(bytes: readonly number[], length: number, verbose: number, emit: (text: string) => void): void {
  if (length < HEADER_BYTES) throw new Invalid(0, length);
  const first = u8(bytes, 0);
  const code = first & OPCODE_MASK;
  const flags = u8(bytes, 1);
  emit(`UDLDv${first >> VERSION_SHIFT}, Code ${CODES[code] ?? 'Reserved'} (${code.toString(16)}), Flags [${flagText(flags)}] (0x${hex(flags, 2)}), length ${length}`);
  let at = 2;
  let remaining = length - 2;
  if (verbose < 1) {
    check(bytes, at, remaining);
    return;
  }
  emit(`\n\tChecksum 0x${hex(u16(bytes, at), 4)} (unverified)`);
  at += 2;
  remaining -= 2;
  while (remaining > 0) {
    if (remaining < TLV_HEADER_BYTES) throw new Invalid(at, remaining);
    const type = u16(bytes, at);
    let valueLength = u16(bytes, at + 2);
    at += TLV_HEADER_BYTES;
    remaining -= TLV_HEADER_BYTES;
    emit(`\n\t${TLV_NAMES[type] ?? 'Unknown'} (0x${hex(type, 4)}) TLV, length ${valueLength}`);
    if (valueLength <= TLV_HEADER_BYTES) throw new Invalid(at, remaining);
    valueLength -= TLV_HEADER_BYTES;
    if (remaining < valueLength) throw new Invalid(at, remaining);
    if (type === 1 || type === 2 || type === 6) {
      emit(`, ${nullPaddedText(bytes.slice(at, at + valueLength))}`);
    } else if (type === 3) {
      check(bytes, at, valueLength);
      emit(`, ${bytes.slice(at, at + valueLength).map(printableByte).join('')}`);
    } else if (type === 4 || type === 5) {
      if (valueLength !== 1) throw new Invalid(at, remaining);
      emit(`, ${u8(bytes, at)}s`);
    } else if (type === 7) {
      if (valueLength !== 4) throw new Invalid(at, remaining);
      emit(`, ${u32(bytes, at)}`);
    } else {
      check(bytes, at, valueLength);
    }
    at += valueLength;
    remaining -= valueLength;
  }
}

export function udldText(bytes: readonly number[], length: number, verbose: number): string {
  let text = '';
  try {
    print(bytes, length, verbose, (piece) => { text += piece; });
  } catch (error) {
    if (error instanceof Truncated) return text + TRUNCATED;
    if (error instanceof Invalid) {
      text += INVALID;
      return error.at + error.remaining > bytes.length ? text + TRUNCATED : text;
    }
    throw error;
  }
  return text;
}
