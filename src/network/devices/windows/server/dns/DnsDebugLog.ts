import { ZonedDate } from '@/network/core/time/ZonedDate';
import { DnsOpcode, encodeDnsHeaderFlags } from '@/network/dns/wire/DnsHeaderFlags';
import { rrTypeName } from '@/network/dns/compat/DnsWireCompat';
import { nsupdateRcodeName } from '@/network/dns/update/NsupdateScript';
import type { DnsPacketEvent, DnsPacketObserver } from '@/network/dns/transport/DnsPacketObserver';
import { LOG_LEVEL, type DnsDebugLogSettings } from './DnsServerDiagnostics';

export interface DnsLogFileSink {
  size(path: string): number | null;
  append(path: string, text: string): void;
  replace(path: string, text: string): void;
}

export interface DnsDebugLogEnvironment {
  readonly level: () => number;
  readonly settings: () => DnsDebugLogSettings;
  readonly files: DnsLogFileSink | null;
  readonly now: () => number;
  readonly timeZone: () => string;
  readonly threadId: number;
}

const SYSTEM_ROOT = 'C:\\Windows';
const DEFAULT_LOG_FILE_NAME = 'dns.log';
const REMOTE_COLUMN_WIDTH = 15;
const QUESTION_TYPE_COLUMN_WIDTH = 6;
const PACKET_ID_BASE = 0x1D3A4B2C000;
const PACKET_ID_STEP = 0x1D0;
const PACKET_ID_DIGITS = 16;
const THREAD_ID_DIGITS = 4;
const HEX = 16;
const NEWLINE = '\r\n';
const BYTE_SHIFT = 8;
const BYTE_MASK = 0xFF;
const KEY_FIELD_WIDTH = 4;
const KEY_FIELD_GAP = '     ';
const KEY_INFORMATION_WIDTH = 20;
const KEY_VALUES_COLUMN = 29;

export function resolveLogFilePath(configured: string): string {
  const path = configured.trim().replace(/\//g, '\\');
  if (path === '') return `${SYSTEM_ROOT}\\System32\\dns\\${DEFAULT_LOG_FILE_NAME}`;
  if (/^[A-Za-z]:\\|^\\\\/.test(path)) return path;
  return path.includes('\\') ? `${SYSTEM_ROOT}\\${path}` : `${SYSTEM_ROOT}\\System32\\dns\\${path}`;
}

const CONTENT_FILTERS: ReadonlyMap<number, { readonly bit: number; readonly letter: string }> = new Map([
  [DnsOpcode.QUERY, { bit: LOG_LEVEL.queries, letter: 'Q' }],
  [DnsOpcode.NOTIFY, { bit: LOG_LEVEL.notifications, letter: 'N' }],
  [DnsOpcode.UPDATE, { bit: LOG_LEVEL.updates, letter: 'U' }],
]);

export function loggedAs(level: number, event: DnsPacketEvent): string | null {
  const { opcode, qr } = event.message.flags;
  const content = CONTENT_FILTERS.get(opcode);
  if (content === undefined) return null;
  const type = qr ? LOG_LEVEL.answers : LOG_LEVEL.questions;
  const direction = event.direction === 'send' ? LOG_LEVEL.send : LOG_LEVEL.receive;
  const transport = event.transport === 'udp' ? LOG_LEVEL.udp : LOG_LEVEL.tcp;
  return [content.bit, type, direction, transport].every(bit => (level & bit) !== 0) ? content.letter : null;
}

function wireName(name: string): string {
  const labels = name.split('.').filter(label => label !== '');
  return labels.map(label => `(${label.length})${label}`).join('') + '(0)';
}

function internalFlags(event: DnsPacketEvent): number {
  const wire = encodeDnsHeaderFlags(event.message.flags);
  return ((wire & BYTE_MASK) << BYTE_SHIFT) | (wire >> BYTE_SHIFT);
}

function hex(value: number, digits: number): string {
  return value.toString(HEX).padStart(digits, '0');
}

function keyRow(field: string, information: string, values = ''): string {
  return `\t${field.padStart(KEY_FIELD_WIDTH)}${KEY_FIELD_GAP}${information.padEnd(KEY_INFORMATION_WIDTH)}${values}`.trimEnd();
}

function keyContinuation(values: string): string {
  return `\t${' '.repeat(KEY_VALUES_COLUMN)}${values}`;
}

export class DnsDebugLog {
  private readonly packetIds = new WeakMap<object, string>();
  private packetCount = 0;

  readonly observe: DnsPacketObserver = (event) => this.record(event);

  constructor(private readonly environment: DnsDebugLogEnvironment) {}

  private record(event: DnsPacketEvent): void {
    const files = this.environment.files;
    if (files === null) return;
    const letter = loggedAs(this.environment.level(), event);
    if (letter === null) return;
    const settings = this.environment.settings();
    if (settings.remotes.length > 0 && !settings.remotes.includes(event.remote)) return;
    const path = resolveLogFilePath(settings.path);
    const line = `${this.packetLine(event, letter)}${NEWLINE}`;
    let size = files.size(path);
    if (size === null || size + line.length > settings.maxBytes) size = this.restart(files, path);
    if (size + line.length > settings.maxBytes) return;
    files.append(path, line);
  }

  private restart(files: DnsLogFileSink, path: string): number {
    const header = this.header();
    files.replace(path, header);
    return header.length;
  }

  private stamp(): string {
    const at = ZonedDate.in(this.environment.now(), this.environment.timeZone());
    const hour = at.getHours();
    const two = (value: number): string => String(value).padStart(2, '0');
    return `${at.getMonth() + 1}/${at.getDate()}/${at.getFullYear()} ${hour % 12 === 0 ? 12 : hour % 12}:${two(at.getMinutes())}:${two(at.getSeconds())} ${hour >= 12 ? 'PM' : 'AM'}`;
  }

  private packetId(exchange: object): string {
    const known = this.packetIds.get(exchange);
    if (known !== undefined) return known;
    this.packetCount += 1;
    const id = hex(PACKET_ID_BASE + this.packetCount * PACKET_ID_STEP, PACKET_ID_DIGITS).toUpperCase();
    this.packetIds.set(exchange, id);
    return id;
  }

  private packetLine(event: DnsPacketEvent, opcodeLetter: string): string {
    const { message } = event;
    const { flags } = message;
    const question = message.questions[0];
    const letters = `${flags.aa ? 'A' : ' '}${flags.tc ? 'T' : ' '}${flags.rd ? 'D' : ' '}${flags.ra ? 'R' : ' '} `;
    const prefix = `${this.stamp()} ${hex(this.environment.threadId, THREAD_ID_DIGITS).toUpperCase()} PACKET  ${this.packetId(event.exchange)}`;
    const route = `${event.transport === 'udp' ? 'UDP' : 'TCP'} ${event.direction === 'send' ? 'Snd' : 'Rcv'} ${event.remote.padEnd(REMOTE_COLUMN_WIDTH)}`;
    const header = `${hex(message.id, THREAD_ID_DIGITS)} ${flags.qr ? 'R' : ' '} ${opcodeLetter} [${hex(internalFlags(event), THREAD_ID_DIGITS)} ${letters} ${nsupdateRcodeName(flags.rcode)}]`;
    const asked = question === undefined ? '' : `${rrTypeName(question.qtype).padEnd(QUESTION_TYPE_COLUMN_WIDTH)} ${wireName(question.qname)}`;
    return `${prefix} ${route} ${header} ${asked}`.trimEnd();
  }

  private header(): string {
    const stamp = this.stamp();
    return [
      `DNS Server log file creation at ${stamp}`,
      `Log file wrap at ${stamp}`,
      'Message logging key (for packets - other items use a subset of these fields):',
      '\tField #  Information         Values',
      '\t-------  -----------         ------',
      keyRow('1', 'Date'),
      keyRow('2', 'Time'),
      keyRow('3', 'Thread ID'),
      keyRow('4', 'Context'),
      keyRow('5', 'Internal packet identifier'),
      keyRow('6', 'UDP/TCP indicator'),
      keyRow('7', 'Send/Receive indicator'),
      keyRow('8', 'Remote IP'),
      keyRow('9', 'Xid (hex)'),
      keyRow('10', 'Query/Response', 'R = Response'),
      keyContinuation('blank = Query'),
      keyRow('11', 'Opcode', 'Q = Standard Query'),
      keyContinuation('N = Notify'),
      keyContinuation('U = Update'),
      keyContinuation('? = Unknown'),
      keyRow('12', '[ Flags (hex)'),
      keyRow('13', 'Flags (char codes)', 'A = Authoritative Answer'),
      keyContinuation('T = Truncated Response'),
      keyContinuation('D = Recursion Desired'),
      keyContinuation('R = Recursion Available'),
      keyRow('14', 'ResponseCode ]'),
      keyRow('15', 'Question Type'),
      keyRow('16', 'Question Name'),
      '',
      '',
    ].join(NEWLINE);
  }
}
