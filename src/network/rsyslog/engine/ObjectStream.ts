import type { OffsetMode, SyslogTime, SyslogTimeType } from '@/network/syslog/codec/SyslogTime';

const COOKIE_OBJECT = '<';
const COOKIE_PROPERTY = '+';
const COOKIE_END = '>';
const COOKIE_BLANK = '.';
const FORMAT_VERSION = '1';
const VARTYPE_STRING = 1;
const VARTYPE_NUMBER = 2;
const VARTYPE_SYSLOGTIME = 3;

export type RecordKind = 'Obj' | 'OPB';

export type PropertyValue =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'time'; readonly value: SyslogTime };

export interface ObjectProperty {
  readonly name: string;
  readonly value: PropertyValue;
}

export interface ObjectRecord {
  readonly kind: RecordKind;
  readonly id: string;
  readonly version: number;
  readonly properties: readonly ObjectProperty[];
  readonly end: number;
}

export class ObjectStreamError extends Error {}

export class ObjectWriter {
  private readonly parts: string[] = [];

  constructor(id: string, version: number, kind: RecordKind = 'Obj') {
    this.parts.push(`${COOKIE_OBJECT}${kind}:${FORMAT_VERSION}:${id}:${version}:\n`);
  }

  private property(name: string, type: number, length: number, data: string): this {
    this.parts.push(`${COOKIE_PROPERTY}${name}:${type}:${length}:${data}:\n`);
    return this;
  }

  string(name: string, value: string | null | undefined): this {
    return value === null || value === undefined ? this : this.property(name, VARTYPE_STRING, value.length, value);
  }

  number(name: string, value: number): this {
    const text = String(value);
    return this.property(name, VARTYPE_NUMBER, text.length, text);
  }

  time(name: string, time: SyslogTime): this {
    const text = [
      time.timeType, time.year, time.month, time.day, time.hour, time.minute, time.second, time.secfrac, time.secfracPrecision,
    ].join(':') + `:${time.offsetMode === '' ? '\0' : time.offsetMode}:${time.offsetHour}:${time.offsetMinute}`;
    return this.property(name, VARTYPE_SYSLOGTIME, text.length, text);
  }

  finish(): string {
    this.parts.push(`${COOKIE_END}End\n${COOKIE_BLANK}\n`);
    return this.parts.join('');
  }
}

class Cursor {
  constructor(readonly text: string, public at: number) {}

  next(): string {
    if (this.at >= this.text.length) throw new ObjectStreamError('end of stream');
    return this.text[this.at++];
  }

  expect(character: string): void {
    if (this.next() !== character) throw new ObjectStreamError(`expected '${character}' at offset ${this.at - 1}`);
  }

  until(terminator: string): string {
    const start = this.at;
    const stop = this.text.indexOf(terminator, start);
    if (stop < 0) throw new ObjectStreamError('end of stream');
    this.at = stop + 1;
    return this.text.slice(start, stop);
  }

  number(): number {
    const raw = this.until(':');
    if (!/^-?\d+$/.test(raw)) throw new ObjectStreamError(`invalid number '${raw}'`);
    return Number(raw);
  }

  peek(): string | null {
    return this.at < this.text.length ? this.text[this.at] : null;
  }
}

function readTime(cursor: Cursor): SyslogTime {
  const timeType = cursor.number() as SyslogTimeType;
  const year = cursor.number();
  const month = cursor.number();
  const day = cursor.number();
  const hour = cursor.number();
  const minute = cursor.number();
  const second = cursor.number();
  const secfrac = cursor.number();
  const secfracPrecision = cursor.number();
  const mode = cursor.next();
  cursor.expect(':');
  const offsetHour = cursor.number();
  const offsetMinute = cursor.number();
  return {
    timeType, year, month, day, hour, minute, second, secfrac, secfracPrecision,
    offsetMode: (mode === '\0' ? '' : mode) as OffsetMode, offsetHour, offsetMinute,
  };
}

function readProperty(cursor: Cursor): ObjectProperty | null {
  if (cursor.peek() !== COOKIE_PROPERTY) return null;
  cursor.next();
  const name = cursor.until(':');
  const type = cursor.number();
  const length = cursor.number();
  let value: PropertyValue;
  if (type === VARTYPE_STRING) {
    const start = cursor.at;
    if (cursor.text.length < start + length) throw new ObjectStreamError('end of stream');
    cursor.at = start + length;
    value = { kind: 'string', value: cursor.text.slice(start, start + length) };
    cursor.expect(':');
  } else if (type === VARTYPE_NUMBER) {
    value = { kind: 'number', value: cursor.number() };
  } else if (type === VARTYPE_SYSLOGTIME) {
    value = { kind: 'time', value: readTime(cursor) };
  } else {
    throw new ObjectStreamError(`invalid variable type ${type}`);
  }
  cursor.expect('\n');
  return { name, value };
}

function readHeader(cursor: Cursor): { kind: RecordKind; id: string; version: number } {
  cursor.expect(COOKIE_OBJECT);
  const kind = cursor.until(':');
  if (kind !== 'Obj' && kind !== 'OPB') throw new ObjectStreamError(`invalid record type '${kind}'`);
  cursor.expect(FORMAT_VERSION);
  cursor.expect(':');
  const id = cursor.until(':');
  const version = cursor.number();
  cursor.until('\n');
  return { kind, id, version };
}

function readTrailer(cursor: Cursor): void {
  cursor.expect(COOKIE_END);
  cursor.expect('E');
  cursor.expect('n');
  cursor.expect('d');
  cursor.expect('\n');
  cursor.expect(COOKIE_BLANK);
  cursor.expect('\n');
}

export function readRecord(text: string, from: number): ObjectRecord {
  const cursor = new Cursor(text, from);
  const header = readHeader(cursor);
  const properties: ObjectProperty[] = [];
  for (let property = readProperty(cursor); property !== null; property = readProperty(cursor)) properties.push(property);
  readTrailer(cursor);
  return { ...header, properties, end: cursor.at };
}

export function readRecords(text: string, from = 0): ObjectRecord[] {
  const records: ObjectRecord[] = [];
  let at = from;
  while (at < text.length) {
    const record = readRecord(text, at);
    records.push(record);
    at = record.end;
  }
  return records;
}
