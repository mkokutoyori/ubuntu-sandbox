import { AUDIT } from './AuditConstants';
import { nameToMessageType } from './AuditEventAssembler';
import { adjustType, elfToMachine, Interpreter } from './AuditInterpret';
import { strtoulBig } from './AuditCNumbers';
import type { EscapeMode } from './AuditPrint';
import { AuparseFeed } from './AuparseFeed';

export interface AuparseField {
  name: string;
  val: string | null;
  item: number;
}

export interface AuparseRecord {
  type: number;
  machine: number;
  syscall: number;
  a0: bigint;
  a1: bigint;
  cwd: string | null;
  item: number;
  fields: AuparseField[];
  cur: number;
  text: string;
}

export interface AuparseTime {
  sec: number;
  milli: number;
  serial: number;
  host: string | null;
}

const KEY_SEPARATOR = String.fromCharCode(0x01);
const URING_MACHINE = 11;

class Splitter {
  private position = 0;

  constructor(private readonly text: string) {}

  next(): string | null {
    for (;;) {
      if (this.position >= this.text.length) return null;
      const end = this.text.indexOf(' ', this.position);
      if (end === this.position) {
        this.position++;
        continue;
      }
      if (end < 0) {
        const token = this.text.slice(this.position);
        this.position = this.text.length;
        return token === '' ? null : token;
      }
      const token = this.text.slice(this.position, end);
      this.position = end + 1;
      return token;
    }
  }
}

function escapeKey(text: string): string {
  let needsHex = false;
  for (const byte of new TextEncoder().encode(text)) if (byte === 0x22 || byte < 0x21 || byte > 0x7e) needsHex = true;
  if (!needsHex) return `"${text}"`;
  return Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join('');
}

function unescapeHex(text: string): string | null {
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) return null;
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 2) bytes.push(parseInt(text.slice(i, i + 2), 16));
  return String.fromCharCode(...bytes);
}

function unsignedParse(text: string, base: number): { value: bigint; failed: boolean } {
  const value = strtoulBig(text, base);
  return { value, failed: false };
}

export function parseUpRecord(text: string, item: number): AuparseRecord | null {
  const record: AuparseRecord = { type: 0, machine: -1, syscall: -1, a0: 0n, a1: 0n, cwd: null, item, fields: [], cur: 0, text };
  const splitter = new Splitter(text);
  let offset = 0;
  const append = (name: string, val: string | null): void => {
    record.fields.push({ name, val, item: record.fields.length });
    record.cur = record.fields.length - 1;
  };
  let token = splitter.next();
  if (token === null) return null;
  do {
    let ptr = token;
    let equals = ptr.indexOf('=');
    if (equals >= 0) {
      if (ptr[0] === 'm' && ptr.startsWith('msg=')) {
        if (ptr[4] === 'a') continue;
        if (ptr[4] === "'") {
          ptr = ptr.slice(5);
          equals = ptr.indexOf('=');
          if (equals < 0) continue;
        }
      }
      let name = ptr.slice(0, equals);
      let val = ptr.slice(equals + 1);
      if (name[0] === '(') name = name.slice(1);
      if (val.length === 0) continue;
      if (val.endsWith(':')) val = val.slice(0, -1);
      if (val.length > 0 && val.endsWith(',')) val = val.slice(0, -1);
      if (val.length > 0 && val.endsWith("'")) val = val.slice(0, -1);
      if (val.length > 0 && val.endsWith(')') && val !== '(none)' && val !== '(null)') val = val.slice(0, -1);
      if (name === 'key' && val[0] !== '(') {
        if (val[0] === '"') append('key', val);
        else {
          const decoded = unescapeHex(val);
          if (decoded === null) append('key', null);
          else for (const part of decoded.split(KEY_SEPARATOR)) if (part !== '') append('key', escapeKey(part));
        }
        continue;
      }
      append(name, val);
      const count = record.fields.length;
      if (count === 1 && name === 'node') offset = 1;
      else if (count === 1 + offset && name === 'type') {
        record.type = nameToMessageType(val);
        if (record.type === AUDIT.URINGOP) record.machine = URING_MACHINE;
      } else if ((count === 2 + offset || count === 11 + offset) && name === 'arch') {
        record.machine = elfToMachine(Number(BigInt.asUintN(32, unsignedParse(val, 16).value)));
      } else if ((count === 3 + offset || count === 12 + offset) && name === 'syscall') {
        record.syscall = Number(BigInt.asIntN(32, unsignedParse(val, 10).value));
      } else if (count === 2 + offset && name === 'uring_op') {
        record.syscall = Number(BigInt.asIntN(32, unsignedParse(val, 10).value));
      } else if ((count === 6 + offset) && name === 'a0') {
        record.a0 = BigInt.asUintN(64, unsignedParse(val, 16).value);
      } else if ((count === 7 + offset) && name === 'a1') {
        record.a1 = BigInt.asUintN(64, unsignedParse(val, 16).value);
      } else if (record.type === AUDIT.CWD) {
        if (name === 'cwd' && record.cwd === null) record.cwd = val;
      }
    } else if (record.type === AUDIT.AVC || record.type === AUDIT.USER_AVC) {
      let name: string | null = null;
      const count = record.fields.length;
      if (count === 1 + offset) {
        if (ptr.startsWith('avc')) continue;
        name = 'seresult';
      } else if (count === 2 + offset) {
        if (ptr[0] === '{') {
          const parts: string[] = [];
          let inner = splitter.next();
          let total = 0;
          let overflow = false;
          while (inner !== null && inner[0] !== '}') {
            if (inner.length + 1 >= 256 - total) {
              overflow = true;
              break;
            }
            if (parts.length > 0) total++;
            parts.push(inner);
            total += inner.length;
            inner = splitter.next();
          }
          if (overflow) return null;
          append('seperms', parts.join(','));
          continue;
        }
      } else continue;
      if (name !== null) append(name, ptr);
    }
  } while ((token = splitter.next()) !== null);
  if (record.fields.length === 0) return null;
  record.cur = 0;
  return record;
}

export class AuparseEvent {
  private current: number | null = 0;
  errno = 0;

  constructor(
    readonly records: AuparseRecord[],
    readonly time: AuparseTime,
    private readonly eventCwd: string | null,
    private readonly interpreter: Interpreter,
    private readonly escapeMode: EscapeMode,
  ) {}

  private get record(): AuparseRecord | null {
    return this.current === null ? null : this.records[this.current] ?? null;
  }

  firstRecord(): number {
    if (this.records.length === 0) return 0;
    this.current = 0;
    this.records[0].cur = 0;
    return 1;
  }

  nextRecord(): number {
    if (this.records.length === 0) return 0;
    if (this.current === null) return 0;
    this.current = this.current + 1 < this.records.length ? this.current + 1 : null;
    return this.current === null ? 0 : 1;
  }

  gotoRecordNum(num: number): number {
    if (num >= this.records.length) return 0;
    this.current = num;
    this.records[num].cur = 0;
    return 1;
  }

  recordNum(): number {
    return this.record?.item ?? 0;
  }

  numRecords(): number {
    return this.records.length;
  }

  type(): number {
    return this.record?.type ?? 0;
  }

  firstField(): number {
    const record = this.record;
    if (record === null) return 0;
    record.cur = 0;
    return 1;
  }

  nextField(): number {
    const record = this.record;
    if (record === null) return 0;
    if (record.fields.length > 0 && record.cur < record.fields.length - 1) {
      record.cur++;
      return 1;
    }
    return 0;
  }

  private findNameFromCurrent(record: AuparseRecord, name: string): boolean {
    if (record.fields.length === 0) return false;
    for (let i = record.cur; i < record.fields.length; i++) {
      if (record.fields[i].name === name) {
        record.cur = i;
        return true;
      }
    }
    return false;
  }

  findField(name: string): string | null {
    const record = this.record;
    if (record === null) return null;
    const field = record.fields[record.cur];
    if (field !== undefined && field.name === name) return field.val;
    return this.findFieldNext(name);
  }

  private findFieldNext(name: string): string | null {
    let moved = false;
    let record = this.record;
    while (record !== null) {
      if (!moved) {
        if (!(record.fields.length > 0 && record.cur < record.fields.length - 1)) return null;
        record.cur++;
        moved = true;
      }
      if (this.findNameFromCurrent(record, name)) return record.fields[record.cur].val;
      this.nextRecord();
      record = this.record;
      if (record !== null) record.cur = 0;
    }
    return null;
  }

  fieldNum(): number {
    const record = this.record;
    return record === null ? 0 : record.fields[record.cur]?.item ?? 0;
  }

  gotoFieldNum(num: number): number {
    const record = this.record;
    if (record === null) return 0;
    if (num >= record.fields.length) return 0;
    record.cur = num;
    return 1;
  }

  fieldName(): string | null {
    const record = this.record;
    return record === null ? null : record.fields[record.cur]?.name ?? null;
  }

  fieldStr(): string | null {
    const record = this.record;
    return record === null ? null : record.fields[record.cur]?.val ?? null;
  }

  fieldInt(): number {
    const value = this.fieldStr();
    if (value === null) {
      this.errno = 61;
      return -1;
    }
    this.errno = 0;
    const match = /^\s*([+-]?)(\d+)/.exec(value);
    if (match === null) return 0;
    const parsed = BigInt(match[1] === '-' ? `-${match[2]}` : match[2]);
    if (parsed > 9223372036854775807n || parsed < -9223372036854775808n) {
      this.errno = 34;
      return -1;
    }
    return Number(BigInt.asIntN(32, parsed));
  }

  fieldType(): string {
    const record = this.record;
    const field = record?.fields[record.cur];
    if (record === null || field === undefined) return 'UNCLASSIFIED';
    return adjustType(record.type, field.name, field.val ?? '');
  }

  private interpret(record: AuparseRecord, cwd: string | null): string | null {
    const field = record.fields[record.cur];
    if (field === undefined) return null;
    const value = field.val ?? '';
    const type = adjustType(record.type, field.name, value);
    return this.interpreter.doInterpretation(type, { machine: record.machine, syscall: record.syscall, a0: record.a0, a1: record.a1, cwd, name: field.name, val: value }, this.escapeMode);
  }

  interpretField(): string | null {
    const record = this.record;
    if (record === null) return null;
    record.cwd = null;
    return this.interpret(record, null);
  }

  interpretRealpath(): string | null {
    const record = this.record;
    if (record === null) return null;
    if (this.fieldType() !== 'ESCAPED_FILE') return null;
    return this.interpret(record, this.eventCwd);
  }

  private interpretSockParts(field: string): string | null {
    const record = this.record;
    if (record === null) return null;
    if (this.fieldType() !== 'SOCKADDR') return null;
    const text = this.interpretField();
    if (text === null) return null;
    const at = text.indexOf(field);
    if (at < 0) return null;
    const rest = text.slice(at + field.length);
    const space = rest.indexOf(' ');
    return space < 0 ? null : rest.slice(0, space);
  }

  interpretSockAddress(): string | null {
    return this.interpretSockParts('laddr=');
  }

  interpretSockFamily(): string | null {
    return this.interpretSockParts('fam=');
  }

  rawValueInRecord(name: string): string | null {
    const record = this.record;
    if (record === null || record.fields.length === 0) return null;
    record.cur = 0;
    return this.findNameFromCurrent(record, name) ? record.fields[record.cur].val : null;
  }

  recordText(): string | null {
    return this.record?.text ?? null;
  }

  typeName(messageTypeToName: (type: number) => string | null): string | null {
    const record = this.record;
    return record === null ? null : messageTypeToName(record.type);
  }
}

export function buildAuparseEvent(lines: readonly string[], time: AuparseTime, interpreter: Interpreter, escapeMode: EscapeMode): AuparseEvent | null {
  const records: AuparseRecord[] = [];
  let cwd: string | null = null;
  for (const line of lines) {
    const parsed = parseUpRecord(line, records.length);
    if (parsed === null) continue;
    if (parsed.cwd !== null) cwd = parsed.cwd;
    records.push(parsed);
  }
  return records.length === 0 ? null : new AuparseEvent(records, time, cwd, interpreter, escapeMode);
}

export function auparseEvents(texts: readonly string[], eoeTimeout: number, interpreter: Interpreter, escapeMode: EscapeMode = 'tty'): AuparseEvent[] {
  const events: AuparseEvent[] = [];
  const feed = new AuparseFeed(eoeTimeout, (ready) => {
    const built = buildAuparseEvent(ready.lines, ready.time, interpreter, escapeMode);
    if (built !== null) events.push(built);
  });
  for (const text of texts) {
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) feed.feed(line);
  }
  feed.flush();
  return events;
}
