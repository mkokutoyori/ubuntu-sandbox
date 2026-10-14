import { binaryStringToBytes, bytesToBinaryString } from '@/crypto/encoding';
export const LOCK_SIZE = 1024;

export interface NanoLockData {
  readonly program: string;
  readonly pid: number;
  readonly user: string;
  readonly host: string;
  readonly name: string;
  readonly modified: boolean;
}

const MODIFIED_BYTE = 0x55;
const MODIFIED_AT = 1007;
const MINIMUM_READ = 68;

function putText(bytes: Uint8Array, at: number, text: string, room: number): void {
  const encoded = new TextEncoder().encode(text).subarray(0, room);
  bytes.set(encoded, at);
}

function textAt(bytes: Uint8Array, from: number, to: number): string {
  const end = bytes.subarray(from, to).indexOf(0);
  return new TextDecoder().decode(bytes.subarray(from, end < 0 ? to : from + end));
}

export function buildNanoLock(data: NanoLockData): string {
  const bytes = new Uint8Array(LOCK_SIZE);
  bytes[0] = 0x62;
  bytes[1] = 0x30;
  putText(bytes, 2, data.program, 10);
  bytes[24] = data.pid % 256;
  bytes[25] = Math.floor(data.pid / 256) % 256;
  bytes[26] = Math.floor(data.pid / 65536) % 256;
  bytes[27] = Math.floor(data.pid / 16777216) % 256;
  putText(bytes, 28, data.user, 16);
  putText(bytes, 68, data.host, 32);
  putText(bytes, 108, data.name, 768);
  bytes[MODIFIED_AT] = data.modified ? MODIFIED_BYTE : 0;
  return bytesToBinaryString(bytes);
}

export function parseNanoLock(content: string): NanoLockData | null {
  const bytes = binaryStringToBytes(content);
  if (bytes.length < MINIMUM_READ || bytes[0] !== 0x62 || bytes[1] !== 0x30) return null;
  return {
    program: textAt(bytes, 2, 12),
    pid: ((bytes[27] * 256 + bytes[26]) * 256 + bytes[25]) * 256 + bytes[24],
    user: textAt(bytes, 28, 44),
    host: textAt(bytes, 68, 100),
    name: textAt(bytes, 108, 876),
    modified: bytes[MODIFIED_AT] === MODIFIED_BYTE,
  };
}

export function lockQuestion(name: string, holder: NanoLockData, columns: number): string {
  const question = 'File %s is being edited by %s (with %s, PID %s); open anyway?';
  const fixed = question.length + holder.user.length + holder.program.length + String(holder.pid).length;
  return question
    .replace('%s', cropToFit(name, columns - fixed + 7))
    .replace('%s', holder.user)
    .replace('%s', holder.program)
    .replace('%s', String(holder.pid));
}

export function cropToFit(name: string, room: number): string {
  if (name.length <= room) return name;
  if (room < 4) return '';
  return `...${name.slice(name.length - room + 3)}`;
}
