import { type SystemdClock, type TimestampStyle, formatTimestamp, type Zone } from '../systemd/SystemdTime';
import { type JournalRecord, cursorOf, fieldNameIsValid } from './JournalRecord';
import {
  JSON_THRESHOLD, PRINT_CHAR_THRESHOLD, PRINT_LINE_THRESHOLD, concat, ellipsizeMem, formatBytes, isPrintableUtf8, stripTabAnsi, text, utf8,
} from './JournalText';

export type OutputMode = 'short' | 'short-full' | 'short-iso' | 'short-iso-precise' | 'short-precise' | 'short-monotonic' | 'short-delta'
| 'short-unix' | 'verbose' | 'export' | 'json' | 'json-pretty' | 'json-sse' | 'json-seq' | 'cat' | 'with-unit';

export const OUTPUT_MODES: readonly OutputMode[] = ['short', 'short-full', 'short-iso', 'short-iso-precise', 'short-precise', 'short-monotonic',
  'short-delta', 'short-unix', 'verbose', 'export', 'json', 'json-pretty', 'json-sse', 'json-seq', 'cat', 'with-unit'];

export const isJsonMode = (mode: OutputMode): boolean => mode === 'json' || mode === 'json-pretty' || mode === 'json-sse' || mode === 'json-seq';

export interface OutputFlags {
  showAll: boolean;
  fullWidth: boolean;
  utc: boolean;
  truncateNewline: boolean;
  noHostname: boolean;
  catalog: boolean;
}

export interface DisplayState {
  previousRealtime: number | null;
  previousMonotonic: number | null;
  previousBootId: string | null;
}

export interface OutputContext {
  clock: SystemdClock;
  columns: number;
  catalogBlock(record: JournalRecord): Uint8Array | null;
  utf8Locale: boolean;
}

export interface ByteSink {
  write(bytes: Uint8Array): void;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (value: number): string => String(value).padStart(2, '0');

function parseUnsigned(bytes: Uint8Array): number | null {
  const value = text(bytes).trim();
  if (!/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

interface Display {
  realtime: number | null;
  monotonic: number | null;
  bootId: string;
}

function displayTimestamp(record: JournalRecord): Display {
  let realtime: number | null = null;
  let monotonic: number | null = null;
  for (const [name, value] of record.fields) {
    if (name === '_SOURCE_REALTIME_TIMESTAMP') realtime = parseUnsigned(value) ?? -1;
    else if (name === '_SOURCE_MONOTONIC_TIMESTAMP') monotonic = parseUnsigned(value) ?? -1;
    if (realtime !== null && monotonic !== null) break;
  }
  const realtimeGood = realtime !== null && realtime > 0;
  const monotonicGood = monotonic !== null && monotonic >= 0;
  return {
    realtime: realtimeGood ? realtime : record.realtimeUsec,
    monotonic: monotonicGood ? monotonic : record.monotonicUsec,
    bootId: record.bootId,
  };
}

function timestampText(mode: OutputMode, flags: OutputFlags, realtime: number, clock: SystemdClock): string {
  if (mode === 'short-full' || mode === 'with-unit') {
    return formatTimestamp(realtime, flags.utc ? 'utc' : 'pretty', clock) ?? '';
  }
  const seconds = Math.floor(realtime / 1_000_000);
  const microseconds = realtime % 1_000_000;
  const zone: Zone = flags.utc ? clock.utc : clock.local;
  const tm = zone.localTime(seconds);
  const gmtoff = zone.utcOffsetSecondsAt(seconds);
  switch (mode) {
    case 'short-unix':
      return `${String(seconds).padStart(10, ' ')}.${String(microseconds).padStart(6, '0')}`;
    case 'short-iso':
    case 'short-iso-precise': {
      let buf = `${String(tm.year).padStart(4, '0')}-${pad2(tm.mon + 1)}-${pad2(tm.mday)}T${pad2(tm.hour)}:${pad2(tm.min)}:${pad2(tm.sec)}`;
      if (mode === 'short-iso-precise') buf += `.${String(microseconds).padStart(6, '0')}`;
      const hours = Math.trunc(gmtoff / 3600);
      const minutes = Math.abs(Math.trunc(gmtoff / 60) % 60);
      const sign = hours < 0 || (hours === 0 && gmtoff < 0) ? '-' : '+';
      return `${buf}${sign}${pad2(Math.abs(hours))}:${pad2(minutes)}`;
    }
    default: {
      let buf = `${MONTHS[tm.mon]} ${pad2(tm.mday)} ${pad2(tm.hour)}:${pad2(tm.min)}:${pad2(tm.sec)}`;
      if (mode === 'short-precise') buf += `.${String(microseconds).padStart(6, '0')}`;
      return buf;
    }
  }
}

function monotonicText(mode: OutputMode, display: Display, state: DisplayState): string {
  const monotonic = display.monotonic as number;
  let buf = `[${String(Math.floor(monotonic / 1_000_000)).padStart(5, ' ')}.${String(monotonic % 1_000_000).padStart(6, '0')}`;
  if (mode === 'short-delta') {
    let delta: number;
    let reliable = true;
    if (state.previousMonotonic !== null && display.bootId === state.previousBootId) delta = Math.max(0, monotonic - state.previousMonotonic);
    else if (display.realtime !== null && state.previousRealtime !== null) {
      delta = Math.max(0, display.realtime - state.previousRealtime);
      reliable = false;
    } else return `${buf}${' '.repeat(16)}]`;
    buf += ` <${String(Math.floor(delta / 1_000_000)).padStart(5, ' ')}.${String(delta % 1_000_000).padStart(6, '0')}${reliable ? ' ' : '*'}>`;
  }
  return `${buf}]`;
}

function printMultiline(out: ByteSink, prefix: number, columns: number, flags: OutputFlags, message: Uint8Array, utf8Locale: boolean): boolean {
  let ellipsized = false;
  if (message.length === 0) out.write(utf8('\n'));
  const NL = 0x0a;
  for (let pos = 0, line = 0; pos < message.length; line++) {
    const indent = line > 0 ? prefix : 0;
    let end = pos;
    while (end < message.length && message[end] !== NL) end++;
    const len = end - pos;
    const tailLine = line + 1 === PRINT_LINE_THRESHOLD || end + 1 >= PRINT_CHAR_THRESHOLD;
    const body = message.slice(pos, end);
    const pad = ' '.repeat(indent);
    if (flags.fullWidth || flags.showAll || (prefix + len + 1 < columns && !tailLine)) {
      out.write(concat(utf8(pad), body, utf8('\n')));
      pos = end + 1;
      continue;
    }
    ellipsized = true;
    if (prefix < columns && columns - prefix >= 3) {
      if (columns - prefix > len + 3) out.write(concat(utf8(pad), body, utf8('...\n')));
      else {
        const shortened = ellipsizeMem(body, columns - prefix, tailLine ? 100 : 90, utf8Locale);
        out.write(shortened === null ? concat(utf8(pad), body, utf8('\n')) : concat(utf8(pad), shortened, utf8('\n')));
      }
    } else out.write(utf8('...\n'));
    if (tailLine) break;
    pos = end + 1;
  }
  return ellipsized;
}

function firstField(record: JournalRecord, name: string): Uint8Array | null {
  for (const [field, value] of record.fields) if (field === name) return value;
  return null;
}

function shallPrint(bytes: Uint8Array, flags: OutputFlags): boolean {
  if (flags.showAll) return true;
  if (bytes.length >= PRINT_CHAR_THRESHOLD) return false;
  return isPrintableUtf8(bytes);
}

function outputShort(out: ByteSink, record: JournalRecord, mode: OutputMode, flags: OutputFlags, display: Display, state: DisplayState, ctx: OutputContext): number {
  const wanted = ['_PID', '_COMM', 'MESSAGE', 'PRIORITY', '_TRANSPORT', '_HOSTNAME', 'SYSLOG_PID', 'SYSLOG_IDENTIFIER', 'CONFIG_FILE', '_SYSTEMD_UNIT', '_SYSTEMD_USER_UNIT', 'DOCUMENTATION'];
  const found = new Map<string, Uint8Array>();
  for (const [name, raw] of record.fields) {
    if (!wanted.includes(name)) continue;
    found.set(name, raw);
  }
  let message = found.get('MESSAGE');
  if (message === undefined) return 0;
  if (!flags.showAll) message = stripTabAnsi(message);
  if (flags.truncateNewline) {
    const newline = message.indexOf(0x0a);
    if (newline >= 0) message = message.slice(0, newline);
  }
  let header = '';
  const parts: Uint8Array[] = [];
  let n = 0;
  if (mode === 'short-monotonic' || mode === 'short-delta') {
    header = monotonicText(mode, display, state);
  } else header = timestampText(mode, flags, display.realtime as number, ctx.clock);
  parts.push(utf8(header));
  n += utf8(header).length;
  let hostname = found.get('_HOSTNAME');
  if (flags.noHostname) hostname = undefined;
  if (hostname && shallPrint(hostname, flags)) {
    parts.push(utf8(' '), hostname);
    n += hostname.length + 1;
  }
  const unit = found.get('_SYSTEMD_UNIT');
  const userUnit = found.get('_SYSTEMD_USER_UNIT');
  const identifier = found.get('SYSLOG_IDENTIFIER');
  const comm = found.get('_COMM');
  if (mode === 'with-unit' && ((unit && shallPrint(unit, flags)) || (userUnit && shallPrint(userUnit, flags)))) {
    if (unit) {
      parts.push(utf8(' '), unit);
      n += unit.length + 1;
    }
    if (userUnit) {
      if (unit) parts.push(utf8('/'), userUnit);
      else parts.push(utf8(' '), userUnit);
      n += (unit ? unit.length : 0) + 1;
    }
  } else if (identifier && shallPrint(identifier, flags)) {
    parts.push(utf8(' '), identifier);
    n += identifier.length + 1;
  } else if (comm && shallPrint(comm, flags)) {
    parts.push(utf8(' '), comm);
    n += comm.length + 1;
  } else parts.push(utf8(' unknown'));
  const pid = found.get('_PID');
  const fakePid = found.get('SYSLOG_PID');
  if (pid && shallPrint(pid, flags)) {
    parts.push(utf8('['), pid, utf8(']'));
    n += pid.length + 2;
  } else if (fakePid && shallPrint(fakePid, flags)) {
    parts.push(utf8('['), fakePid, utf8(']'));
    n += fakePid.length + 2;
  }
  parts.push(utf8(': '));
  out.write(concat(...parts));
  let ellipsized = false;
  if (!flags.showAll && !isPrintableUtf8(message)) out.write(utf8(`[${formatBytes(message.length)} blob data]\n`));
  else ellipsized = printMultiline(out, n + 2, ctx.columns, flags, message, ctx.utf8Locale);
  if (flags.catalog) printCatalog(out, record, ctx);
  return ellipsized ? 1 : 0;
}

function printCatalog(out: ByteSink, record: JournalRecord, ctx: OutputContext): void {
  const block = ctx.catalogBlock(record);
  if (block !== null) out.write(block);
}

function outputVerbose(out: ByteSink, record: JournalRecord, flags: OutputFlags, display: Display, outputFields: ReadonlySet<string> | null, ctx: OutputContext): number {
  const style: TimestampStyle = flags.utc ? 'us-utc' : 'us';
  const stamp = formatTimestamp(display.realtime as number, style, ctx.clock) ?? '(no timestamp)';
  out.write(utf8(`${stamp} [${cursorOf(record)}]\n`));
  for (const [name, value] of record.fields) {
    if (!fieldNameIsValid(name, true)) return -1;
    if (outputFields !== null && !outputFields.has(name)) continue;
    const length = name.length + 1 + value.length;
    const whole = concat(utf8(`${name}=`), value);
    if (flags.showAll || ((length < PRINT_CHAR_THRESHOLD || flags.fullWidth) && isPrintableUtf8(whole))) {
      out.write(utf8(`    ${name}=`));
      printMultiline(out, 4 + name.length + 1, 0, { ...flags, fullWidth: true, showAll: false }, value, ctx.utf8Locale);
    } else out.write(utf8(`    ${name}=[${formatBytes(value.length)} blob data]\n`));
  }
  if (flags.catalog) printCatalog(out, record, ctx);
  return 0;
}

function outputExport(out: ByteSink, record: JournalRecord, outputFields: ReadonlySet<string> | null): number {
  out.write(utf8(`__CURSOR=${cursorOf(record)}\n__REALTIME_TIMESTAMP=${record.realtimeUsec}\n__MONOTONIC_TIMESTAMP=${record.monotonicUsec}\n__SEQNUM=${record.seqnum}\n__SEQNUM_ID=${record.seqnumId}\n_BOOT_ID=${record.bootId}\n`));
  for (const [name, value] of record.fields) {
    if (name === '_BOOT_ID') continue;
    if (!fieldNameIsValid(name, true)) return -1;
    if (outputFields !== null && !outputFields.has(name)) continue;
    const whole = concat(utf8(`${name}=`), value);
    if (isPrintableUtf8(whole, false)) out.write(concat(whole, utf8('\n')));
    else {
      const length = new Uint8Array(8);
      new DataView(length.buffer).setBigUint64(0, BigInt(value.length), true);
      out.write(concat(utf8(`${name}\n`), length, value, utf8('\n')));
    }
  }
  out.write(utf8('\n'));
  return 0;
}

export type JsonValue = string | number | null | JsonValue[] | { object: Array<[string, JsonValue]> };
const INDENT = '\t';

export function jsonString(value: Uint8Array): string {
  let out = '"';
  const decoded = text(value);
  for (const ch of decoded) {
    const code = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (code === 8) out += '\\b';
    else if (code === 12) out += '\\f';
    else if (code === 10) out += '\\n';
    else if (code === 13) out += '\\r';
    else if (code === 9) out += '\\t';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

export function formatJson(value: JsonValue, pretty: boolean, prefix: string): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (!pretty) return `[${value.map(element => formatJson(element, false, prefix)).join(',')}]`;
    const inner = `${prefix}${INDENT}`;
    return `[\n${value.map(element => `${inner}${formatJson(element, true, inner)}`).join(',\n')}\n${prefix}]`;
  }
  const entries = (value as { object: Array<[string, JsonValue]> }).object;
  if (entries.length === 0) return '{}';
  if (!pretty) return `{${entries.map(([key, element]) => `${jsonString(utf8(key))}:${formatJson(element, false, prefix)}`).join(',')}}`;
  const inner = `${prefix}${INDENT}`;
  return `{\n${entries.map(([key, element]) => `${inner}${jsonString(utf8(key))} : ${formatJson(element, true, inner)}`).join(',\n')}\n${prefix}}`;
}

function jsonScalar(name: string, value: Uint8Array, flags: OutputFlags): JsonValue {
  if (!flags.showAll && name.length + 1 + value.length >= JSON_THRESHOLD) return null;
  if (isPrintableUtf8(value)) return jsonString(value);
  return Array.from(value);
}

function outputJson(out: ByteSink, record: JournalRecord, mode: OutputMode, flags: OutputFlags, outputFields: ReadonlySet<string> | null): number {
  const entries = new Map<string, JsonValue[]>();
  const add = (name: string, value: Uint8Array): void => {
    const element = jsonScalar(name, value, flags);
    const list = entries.get(name);
    if (list) list.push(element);
    else entries.set(name, [element]);
  };
  add('__CURSOR', utf8(cursorOf(record)));
  add('__REALTIME_TIMESTAMP', utf8(String(record.realtimeUsec)));
  add('__MONOTONIC_TIMESTAMP', utf8(String(record.monotonicUsec)));
  add('_BOOT_ID', utf8(record.bootId));
  add('__SEQNUM', utf8(String(record.seqnum)));
  add('__SEQNUM_ID', utf8(record.seqnumId));
  for (const [name, value] of record.fields) {
    if (name === '_BOOT_ID') continue;
    if (!fieldNameIsValid(name, true)) return -1;
    if (outputFields !== null && !outputFields.has(name)) continue;
    add(name, value);
  }
  const object: JsonValue = { object: [...entries].map(([name, list]): [string, JsonValue] => [name, list.length === 1 ? list[0] : list]) };
  out.write(utf8(dumpJson(object, mode)));
  return 0;
}

export function dumpJson(value: JsonValue, mode: OutputMode): string {
  const body = formatJson(value, mode === 'json-pretty', '');
  const frame = mode === 'json-sse' ? { head: 'data: ', tail: '\n\n' } : mode === 'json-seq' ? { head: '\x1e', tail: '\n' } : { head: '', tail: '\n' };
  return `${frame.head}${body}${frame.tail}`;
}

function outputCat(out: ByteSink, record: JournalRecord, outputFields: ReadonlySet<string> | null): number {
  const fields = outputFields === null || outputFields.size === 0 ? ['MESSAGE'] : [...outputFields];
  for (const name of fields) {
    const value = firstField(record, name);
    if (value === null) continue;
    out.write(concat(value, utf8('\n')));
  }
  return 0;
}

export function showJournalEntry(
  out: ByteSink, record: JournalRecord, mode: OutputMode, flags: OutputFlags, outputFields: ReadonlySet<string> | null, state: DisplayState, ctx: OutputContext,
): { status: number; ellipsized: boolean; error?: string } {
  const display = displayTimestamp(record);
  let status = 0;
  const shortMode = mode.startsWith('short') || mode === 'with-unit';
  if (shortMode) {
    if (mode === 'short-monotonic' || mode === 'short-delta') {
      if (display.monotonic === null) return { status: -1, ellipsized: false, error: 'No valid monotonic timestamp available' };
    } else if (display.realtime === null) return { status: -1, ellipsized: false, error: 'No valid realtime timestamp available' };
    status = outputShort(out, record, mode, flags, display, state, ctx);
  } else if (mode === 'verbose') status = outputVerbose(out, record, flags, display, outputFields, ctx);
  else if (mode === 'export') status = outputExport(out, record, outputFields);
  else if (isJsonMode(mode)) status = outputJson(out, record, mode, flags, outputFields);
  else status = outputCat(out, record, outputFields);
  state.previousRealtime = display.realtime;
  state.previousMonotonic = display.monotonic;
  state.previousBootId = display.bootId;
  if (status < 0) return { status, ellipsized: false, error: 'Invalid field.' };
  return { status: 0, ellipsized: status > 0 };
}

