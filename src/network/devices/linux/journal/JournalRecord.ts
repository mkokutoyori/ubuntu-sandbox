export interface JournalRecord {
  readonly fields: ReadonlyArray<readonly [string, Uint8Array]>;
  readonly realtimeUsec: number;
  readonly monotonicUsec: number;
  readonly seqnum: number;
  readonly seqnumId: string;
  readonly bootId: string;
  readonly xorHash: string;
}

export function cursorOf(record: JournalRecord): string {
  return `s=${record.seqnumId};i=${record.seqnum.toString(16)};b=${record.bootId};m=${record.monotonicUsec.toString(16)};t=${record.realtimeUsec.toString(16)};x=${record.xorHash}`;
}

export function fieldValues(record: JournalRecord, name: string): Uint8Array[] {
  const values: Uint8Array[] = [];
  for (const [field, value] of record.fields) if (field === name) values.push(value);
  return values;
}

export function firstValue(record: JournalRecord, name: string): Uint8Array | null {
  for (const [field, value] of record.fields) if (field === name) return value;
  return null;
}

export function fieldNameIsValid(name: string, allowProtected: boolean): boolean {
  if (name.length === 0 || name.length > 64) return false;
  if (!allowProtected && name[0] === '_') return false;
  if (name[0] >= '0' && name[0] <= '9') return false;
  return /^[A-Z0-9_]+$/.test(name);
}

export interface JournalCursor {
  seqnumId?: string;
  seqnum?: number;
  bootId?: string;
  monotonic?: number;
  realtime?: number;
  xorHash?: bigint;
}

const ID128 = /^[0-9a-fA-F]{32}$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const parseId128 = (text: string): string | null => (ID128.test(text) ? text.replace(/-/g, '').toLowerCase() : null);

function scanHex(text: string): bigint | null {
  const match = /^\s*(?:[+-])?(?:0[xX])?([0-9a-fA-F]+)/.exec(text);
  if (match === null) return null;
  const negative = /^\s*-/.test(text);
  const value = BigInt(`0x${match[1]}`);
  return negative ? (1n << 64n) - value : value;
}

export function parseCursor(cursor: string): JournalCursor | 'EINVAL' {
  if (cursor === '') return 'EINVAL';
  const result: JournalCursor = {};
  const words = cursor.split(';');
  if (words[words.length - 1] === '') words.pop();
  for (const word of words) {
    if (word === '' || word[1] !== '=') return 'EINVAL';
    const value = word.slice(2);
    switch (word[0]) {
      case 's': {
        const id = parseId128(value);
        if (id === null) return 'EINVAL';
        result.seqnumId = id;
        break;
      }
      case 'b': {
        const id = parseId128(value);
        if (id === null) return 'EINVAL';
        result.bootId = id;
        break;
      }
      case 'i': {
        const parsed = scanHex(value);
        if (parsed === null) return 'EINVAL';
        result.seqnum = Number(parsed);
        break;
      }
      case 'm': {
        const parsed = scanHex(value);
        if (parsed === null) return 'EINVAL';
        result.monotonic = Number(parsed);
        break;
      }
      case 't': {
        const parsed = scanHex(value);
        if (parsed === null) return 'EINVAL';
        result.realtime = Number(parsed);
        break;
      }
      case 'x': {
        const parsed = scanHex(value);
        if (parsed === null) return 'EINVAL';
        result.xorHash = parsed;
        break;
      }
    }
  }
  const seqnumSet = result.seqnum !== undefined && result.seqnumId !== undefined;
  const monotonicSet = result.monotonic !== undefined && result.bootId !== undefined;
  if (!seqnumSet && !monotonicSet && result.realtime === undefined) return 'EINVAL';
  return result;
}
