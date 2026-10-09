import { END_OF_OPTIONS, GnuGetopt, type LongOption } from '../audit/tools/GnuGetopt';
import type { HostClock } from '../audit/tools/AuditHostClock';
import { ExitSignal, ToolOutput, type ToolResult } from '../audit/tools/AuditToolHost';

export const LOGGER_VERSION = 'util-linux 2.39.3';

const TYPE_UDP = 2;
const TYPE_TCP = 4;
const ALL_TYPES = TYPE_UDP | TYPE_TCP;
const LOG_PRIMASK = 0x07;
const LOG_FACMASK = 0x03f8;
const LOG_USER = 1 << 3;
const LOG_KERN = 0;
const LOG_NOTICE = 5;
const DEFAULT_SOCKET = '/dev/log';
const PRIO_MAX = 191;

const FACILITIES: ReadonlyArray<readonly [string, number]> = [
  ['auth', 4 << 3], ['authpriv', 10 << 3], ['cron', 9 << 3], ['daemon', 3 << 3], ['ftp', 11 << 3], ['kern', 0], ['lpr', 6 << 3],
  ['mail', 2 << 3], ['mark', 24 << 3], ['news', 7 << 3], ['security', 4 << 3], ['syslog', 5 << 3], ['user', 1 << 3], ['uucp', 8 << 3],
  ['local0', 16 << 3], ['local1', 17 << 3], ['local2', 18 << 3], ['local3', 19 << 3], ['local4', 20 << 3], ['local5', 21 << 3],
  ['local6', 22 << 3], ['local7', 23 << 3],
];

const PRIORITIES: ReadonlyArray<readonly [string, number]> = [
  ['alert', 1], ['crit', 2], ['debug', 7], ['emerg', 0], ['err', 3], ['error', 3], ['info', 6], ['none', 0x10], ['notice', 5],
  ['panic', 0], ['warn', 4], ['warning', 4],
];

export interface LoggerConnection {
  send(bytes: Uint8Array, credentialsPid: number | null): string | null;
  close(): void;
}

export type LoggerOpen = { connection: LoggerConnection; type: number } | { error: string };

export interface LoggerHost {
  nowMicros(): number;
  clock: HostClock;
  hostname(): string | null;
  pid(): number;
  login(): string | null;
  isRoot(): boolean;
  processExists(pid: number): boolean;
  sdBooted(): boolean;
  connectUnix(path: string, types: number): LoggerOpen;
  connectInet(server: string, port: string | null, types: number): LoggerOpen | { fatal: string };
  readFile(path: string): { bytes: Uint8Array } | { error: string };
  stdin(): Uint8Array;
  journal(fields: string[]): boolean;
}

interface StructuredData {
  id: string;
  params: string[];
}

interface Control {
  connection: LoggerConnection | null;
  pri: number;
  pid: number;
  header: Uint8Array;
  tag: string | null;
  msgid: string | null;
  unixSocket: string | null;
  server: string | null;
  port: string | null;
  socketType: number;
  maxMessageSize: number;
  userSds: StructuredData[];
  reservedSds: StructuredData[];
  headerBuilder: ((ctl: Control) => void) | null;
  unixSocketErrors: boolean;
  noact: boolean;
  prioPrefix: boolean;
  stderrPrintout: boolean;
  rfc5424Time: boolean;
  rfc5424Tq: boolean;
  rfc5424Host: boolean;
  skipEmptyLines: boolean;
  octetCount: boolean;
}

const OPT = { PRIO_PREFIX: 257, JOURNALD: 258, RFC3164: 259, RFC5424: 260, SOCKET_ERRORS: 261, MSGID: 262, NOACT: 263, ID: 264, SD_ID: 265, SD_PARAM: 266, OCTET_COUNT: 267 } as const;

const OPTION_TABLE: readonly LongOption[] = [
  { name: 'id', hasArg: 2, val: OPT.ID },
  { name: 'stderr', hasArg: 0, val: 115 },
  { name: 'file', hasArg: 1, val: 102 },
  { name: 'no-act', hasArg: 0, val: OPT.NOACT },
  { name: 'priority', hasArg: 1, val: 112 },
  { name: 'tag', hasArg: 1, val: 116 },
  { name: 'socket', hasArg: 1, val: 117 },
  { name: 'socket-errors', hasArg: 1, val: OPT.SOCKET_ERRORS },
  { name: 'udp', hasArg: 0, val: 100 },
  { name: 'tcp', hasArg: 0, val: 84 },
  { name: 'server', hasArg: 1, val: 110 },
  { name: 'port', hasArg: 1, val: 80 },
  { name: 'version', hasArg: 0, val: 86 },
  { name: 'help', hasArg: 0, val: 104 },
  { name: 'octet-count', hasArg: 0, val: OPT.OCTET_COUNT },
  { name: 'prio-prefix', hasArg: 0, val: OPT.PRIO_PREFIX },
  { name: 'rfc3164', hasArg: 0, val: OPT.RFC3164 },
  { name: 'rfc5424', hasArg: 2, val: OPT.RFC5424 },
  { name: 'size', hasArg: 1, val: 83 },
  { name: 'msgid', hasArg: 1, val: OPT.MSGID },
  { name: 'skip-empty', hasArg: 0, val: 101 },
  { name: 'sd-id', hasArg: 1, val: OPT.SD_ID },
  { name: 'sd-param', hasArg: 1, val: OPT.SD_PARAM },
  { name: 'journald', hasArg: 2, val: OPT.JOURNALD },
];

const encoder = new TextEncoder();
const bytesOf = (text: string): Uint8Array => encoder.encode(text);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function cutAtNul(bytes: Uint8Array): Uint8Array {
  const end = bytes.indexOf(0);
  return end < 0 ? bytes : bytes.subarray(0, end);
}

function decode(name: string, table: ReadonlyArray<readonly [string, number]>): number {
  if (name === '') return -1;
  if (/^\d/.test(name)) {
    if (!/^\d+$/.test(name)) return -1;
    const value = Number(name);
    return table.some(([, code]) => code === value) ? value : -1;
  }
  const entry = table.find(([label]) => label.toLowerCase() === name.toLowerCase());
  return entry ? entry[1] : -1;
}

function strtosize(text: string): { value: bigint } | { error: string } {
  if (text === '') return { error: 'Invalid argument' };
  const trimmed = text.replace(/^[ \t\n\v\f\r]+/, '');
  if (trimmed[0] === '-') return { error: 'Invalid argument' };
  const match = /^(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/.exec(trimmed.replace(/^\+/, ''));
  if (!match) return { error: 'Invalid argument' };
  const literal = match[1];
  let value = literal.startsWith('0x') || literal.startsWith('0X') ? BigInt(literal) : literal.length > 1 && literal.startsWith('0') ? BigInt(`0o${literal.slice(1)}`) : BigInt(literal);
  const max = 18446744073709551615n;
  if (value > max) return { error: 'Numerical result out of range' };
  let rest = trimmed.replace(/^\+/, '').slice(literal.length);
  if (rest === '') return { value };
  let fraction = 0n;
  let fractionZeros = 0;
  let base = 1000n;
  let power = 0;
  for (;;) {
    if (rest[1] === 'i' && (rest[2] === 'B' || rest[2] === 'b') && rest.length === 3) base = 1024n;
    else if ((rest[1] === 'B' || rest[1] === 'b') && rest.length === 2) base = 1000n;
    else if (rest.length > 1) {
      if (fraction === 0n && rest[0] === '.') {
        let p = 1;
        while (rest[p] === '0') { fractionZeros++; p++; }
        const digits = /^\d+/.exec(rest.slice(p));
        let after = p;
        if (digits) {
          fraction = BigInt(digits[0]);
          after = p + digits[0].length;
        }
        if (fraction !== 0n && after >= rest.length) return { error: 'Invalid argument' };
        rest = rest.slice(after);
        base = 1024n;
        continue;
      }
      return { error: 'Invalid argument' };
    }
    break;
  }
  const upper = 'KMGTPEZY';
  const index = upper.indexOf(rest[0]) >= 0 ? upper.indexOf(rest[0]) : upper.toLowerCase().indexOf(rest[0]);
  if (index < 0) return { error: 'Invalid argument' };
  power = index + 1;
  const scale = (n: bigint): bigint => {
    let result = n;
    for (let i = 0; i < power; i++) result *= base;
    return result;
  };
  if (scale(1n) > max || value * scale(1n) > max) return { error: 'Numerical result out of range' };
  value = scale(value);
  if (fraction !== 0n && power > 0) {
    let fractionDivisor = 10n;
    let fractionPosition = 1n;
    const fractionBase = scale(1n);
    while (fractionDivisor < fraction) {
      if (fractionDivisor <= max / 10n) fractionDivisor *= 10n; else fraction /= 10n;
    }
    for (let i = 0; i < fractionZeros; i++) {
      if (fractionDivisor <= max / 10n) fractionDivisor *= 10n; else fraction /= 10n;
    }
    do {
      const segment = fraction % 10n;
      const segmentDivisor = fractionDivisor / fractionPosition;
      fraction /= 10n;
      fractionPosition *= 10n;
      if (segment !== 0n && segmentDivisor / segment !== 0n) value += fractionBase / (segmentDivisor / segment);
    } while (fraction !== 0n);
  }
  return { value };
}

function strchrEscaped(text: string, from: number, wanted: string): number {
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    if (!escaped && text[i] === '\\') { escaped = true; continue; }
    if (text[i] === wanted && (!escaped || wanted === '\\')) return i;
    escaped = false;
  }
  return -1;
}

function validStructuredParam(text: string): boolean {
  const eq = text.indexOf('=');
  const qm1 = text.indexOf('"');
  const qm2 = qm1 >= 0 ? strchrEscaped(text, qm1 + 1, '"') : -1;
  if (eq < 0 || qm1 < 0 || qm2 < 0) return false;
  for (let s = qm1 + 1; s < text.length;) {
    const p = text.indexOf(']', s);
    if (p < 0) break;
    if (p > qm2 || p === strchrEscaped(text, s, ']')) return false;
    s = p + 1;
  }
  for (let s = qm1 + 1; s < text.length;) {
    const p = text.indexOf('\\', s);
    if (p < 0) break;
    if (!'[]"\\'.includes(text[p + 1] ?? '\0')) return false;
    s = p + 1;
    if (text[s] === '\\') s++;
  }
  return eq > 0 && eq < qm1 && eq + 1 === qm1 && qm1 < qm2 && qm2 + 1 === text.length;
}

function validStructuredId(text: string): boolean {
  const at = text.indexOf('@');
  if (at < 0 && (text === 'timeQuality' || text === 'origin' || text === 'meta')) return true;
  if (at < 0 || at === 0 || at + 1 >= text.length) return false;
  const tail = text.slice(at + 1);
  const groups = tail.split('.');
  if (groups.some((group) => !/^\d+$/.test(group))) return false;
  for (let i = 0; i < at; i++) {
    const ch = text[i];
    if (ch === '[' || ch === '=' || ch === '"' || ch === '@') return false;
    if (ch === ' ' || ch === '\t' || text.charCodeAt(i) < 32 || text.charCodeAt(i) === 127) return false;
  }
  return true;
}

export function runLogger(host: LoggerHost, argv: string[], program = 'logger'): ToolResult {
  const out = new ToolOutput();
  let exitCode = 0;
  const err = (message: string, errnoText: string): never => {
    out.eprintf(`${program}: ${message}: ${errnoText}\n`);
    throw new ExitSignal(1);
  };
  const errx = (message: string): never => {
    out.eprintf(`${program}: ${message}\n`);
    throw new ExitSignal(1);
  };
  const warnx = (message: string): void => out.eprintf(`${program}: ${message}\n`);

  const ctl: Control = {
    connection: null, pri: LOG_USER | LOG_NOTICE, pid: 0, header: new Uint8Array(0), tag: null, msgid: null, unixSocket: null, server: null,
    port: null, socketType: ALL_TYPES, maxMessageSize: 1024, userSds: [], reservedSds: [], headerBuilder: null, unixSocketErrors: false,
    noact: false, prioPrefix: false, stderrPrintout: false, rfc5424Time: true, rfc5424Tq: true, rfc5424Host: true, skipEmptyLines: false,
    octetCount: false,
  };

  const pencode = (original: string): number => {
    const dot = original.indexOf('.');
    let facility: number;
    let levelName = original;
    if (dot >= 0) {
      const facilityName = original.slice(0, dot);
      facility = decode(facilityName, FACILITIES);
      if (facility < 0) errx(`unknown facility name: ${facilityName}`);
      levelName = original.slice(dot + 1);
    } else facility = LOG_USER;
    const level = decode(levelName, PRIORITIES);
    if (level < 0) errx(`unknown priority name: ${levelName}`);
    if (facility === LOG_KERN) facility = LOG_USER;
    return (level & LOG_PRIMASK) | (facility & LOG_FACMASK);
  };

  const rfc3164Time = (): string => {
    const tm = host.clock.localTime(Math.floor(host.nowMicros() / 1_000_000));
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const two = (n: number): string => String(n).padStart(2, '0');
    return `${months[tm.mon]} ${String(tm.mday).padStart(2, ' ')} ${two(tm.hour)}:${two(tm.min)}:${two(tm.sec)}`;
  };

  const hasStructuredId = (list: StructuredData[], id: string): boolean => list.some((entry) => entry.id === id);
  const addStructuredId = (list: StructuredData[], id: string): void => {
    if (hasStructuredId(list, id)) errx(`structured data ID '${id}' is not unique`);
    list.push({ id, params: [] });
  };
  const addStructuredParam = (list: StructuredData[], param: string): void => {
    if (list.length === 0) errx(`--sd-id was not specified for --sd-param ${param}`);
    list[list.length - 1].params.push(param);
  };
  const structuredText = (list: StructuredData[]): string | null => {
    let result: string | null = null;
    for (const entry of list) {
      if (entry.params.length === 0) continue;
      result = `${result ?? ''}[${entry.id} ${entry.params.join(' ')}]`;
    }
    return result;
  };

  const tagOf = (): string => ctl.tag ?? '';
  const localHeader = (): void => {
    const pid = ctl.pid ? `[${ctl.pid}]` : '';
    ctl.header = bytesOf(`<${ctl.pri}>${rfc3164Time()} ${tagOf()}${pid}: `);
  };
  const rfc3164Header = (): void => {
    const pid = ctl.pid ? `[${ctl.pid}]` : '';
    let hostname = host.hostname();
    hostname = hostname === null ? '-' : hostname.split('.')[0];
    ctl.header = bytesOf(`<${ctl.pri}>${rfc3164Time().slice(0, 15)} ${hostname} ${tagOf().slice(0, 200)}${pid}: `);
  };
  const rfc5424Header = (): void => {
    const msgid = ctl.msgid ?? '-';
    let time = '-';
    if (ctl.rfc5424Time) {
      const micros = host.nowMicros();
      const seconds = Math.floor(micros / 1_000_000);
      const tm = host.clock.localTime(seconds);
      const two = (n: number): string => String(n).padStart(2, '0');
      const offset = Math.round(Date.UTC(tm.year, tm.mon, tm.mday, tm.hour, tm.min, tm.sec) / 1000) - seconds;
      const minutes = Math.abs(Math.trunc(offset / 60));
      const zone = `${offset < 0 ? '-' : '+'}${two(Math.trunc(minutes / 60))}:${two(minutes % 60)}`;
      const micro = String(micros % 1_000_000).padStart(6, '0');
      time = `${tm.year}-${two(tm.mon + 1)}-${two(tm.mday)}T${two(tm.hour)}:${two(tm.min)}:${two(tm.sec)}.${micro}${zone}`;
    }
    let hostname = '-';
    if (ctl.rfc5424Host) {
      hostname = host.hostname() ?? '-';
      if (hostname.length > 255) errx(`hostname '${hostname}' is too long`);
    }
    if (tagOf().length > 48) errx(`tag '${tagOf()}' is too long`);
    const procid = ctl.pid ? String(ctl.pid) : '-';
    if (ctl.rfc5424Tq && !hasStructuredId(ctl.reservedSds, 'timeQuality')) {
      addStructuredId(ctl.reservedSds, 'timeQuality');
      addStructuredParam(ctl.reservedSds, 'tzKnown="1"');
      addStructuredParam(ctl.reservedSds, 'isSynced="0"');
    }
    const reserved = ctl.reservedSds.length > 0 ? structuredText(ctl.reservedSds) : null;
    const user = ctl.userSds.length > 0 ? structuredText(ctl.userSds) : null;
    const structured = reserved !== null && user !== null ? reserved + user : reserved ?? user ?? '-';
    ctl.header = bytesOf(`<${ctl.pri}>1 ${time} ${hostname} ${tagOf()} ${procid} ${msgid} ${structured} `);
  };

  const openOnce = (): void => {
    let opened: LoggerOpen | { fatal: string };
    if (ctl.server !== null) {
      opened = host.connectInet(ctl.server, ctl.port, ctl.socketType);
      if ('fatal' in opened) errx(opened.fatal);
      if ('error' in opened) errx(`failed to connect to ${ctl.server} port ${ctl.port ?? (ctl.socketType & TYPE_UDP ? 'syslog' : 'syslog-conn')}`);
    } else {
      if (ctl.unixSocket === null) ctl.unixSocket = DEFAULT_SOCKET;
      if (ctl.unixSocket.length >= 108) errx(`openlog ${ctl.unixSocket}: pathname too long`);
      opened = host.connectUnix(ctl.unixSocket, ctl.socketType);
      if ('error' in opened) {
        if (ctl.unixSocketErrors) err(`socket ${ctl.unixSocket}`, opened.error);
        ctl.connection = null;
        return;
      }
    }
    const success = opened as { connection: LoggerConnection; type: number };
    if (success.type > 0 && success.type !== ctl.socketType) ctl.socketType = success.type;
    ctl.connection = success.connection;
  };
  const reopen = (): void => {
    ctl.connection?.close();
    ctl.connection = null;
    openOnce();
  };

  const writeOutput = (message: Uint8Array): void => {
    const text = cutAtNul(message);
    if (!ctl.noact && ctl.connection === null) reopen();
    const parts: Uint8Array[] = [];
    if (ctl.octetCount) parts.push(bytesOf(`${ctl.header.length + text.length} `));
    parts.push(ctl.header, text);
    if (!ctl.noact && ctl.connection !== null) {
      if (ctl.socketType === TYPE_TCP && !ctl.octetCount) parts.push(bytesOf('\n'));
      const payload = concat(...parts);
      const credentials = ctl.pid && ctl.server === null && ctl.pid !== host.pid() && host.isRoot() && host.processExists(ctl.pid) ? ctl.pid : null;
      let failure = ctl.connection.send(payload, credentials);
      if (failure !== null) {
        reopen();
        failure = ctl.connection === null ? failure : (ctl.connection as LoggerConnection).send(payload, credentials);
        if (failure !== null) out.eprintf(`${program}: send message failed: ${failure}\n`);
      }
    }
    if (ctl.stderrPrintout) {
      const body = concat(...parts);
      const terminated = body[body.length - 1] === 10 ? body : concat(body, bytesOf('\n'));
      out.eprintf(new TextDecoder().decode(terminated));
    }
  };

  const generateHeader = (): void => {
    ctl.header = new Uint8Array(0);
    (ctl.headerBuilder ?? (() => undefined))(ctl);
  };

  try {
    let stdoutReopened = false;
    let stdinOverride: Uint8Array | null = null;
    let journalSource: { text: string } | null = null;
    let socketErrorsMode: 'off' | 'on' | 'auto' = 'auto';
    const getopt = new GnuGetopt([program, ...argv], 'ef:ip:S:st:u:dTn:P:Vh', OPTION_TABLE, { program, write: (text) => out.eprintf(text) });
    for (;;) {
      const { code, optarg } = getopt.next();
      if (code === END_OF_OPTIONS) break;
      switch (code) {
        case 102: {
          const file = host.readFile(optarg ?? '');
          if ('error' in file) err(`file ${optarg}`, file.error);
          stdinOverride = (file as { bytes: Uint8Array }).bytes;
          stdoutReopened = true;
          break;
        }
        case 101: ctl.skipEmptyLines = true; break;
        case 105: ctl.pid = host.pid(); break;
        case OPT.ID:
          if (optarg !== null) {
            const parsed = /^[ \t\n\v\f\r]*([+-]?)(\d+)$/.exec(optarg);
            if (!parsed) errx(`failed to parse id: '${optarg}'`);
            const value = BigInt((parsed as RegExpExecArray)[2]) * ((parsed as RegExpExecArray)[1] === '-' ? -1n : 1n);
            if (value < 0n || value > 9223372036854775807n) err(`failed to parse id: '${optarg}'`, 'Numerical result out of range');
            ctl.pid = Number(BigInt.asIntN(32, value));
          } else ctl.pid = host.pid();
          break;
        case 112: ctl.pri = pencode(optarg ?? ''); break;
        case 115: ctl.stderrPrintout = true; break;
        case 116: ctl.tag = optarg; break;
        case 117: ctl.unixSocket = optarg; break;
        case 83: {
          const size = strtosize(optarg ?? '');
          if ('error' in size) {
            out.eprintf(`${program}: failed to parse message size: '${optarg}': ${size.error}\n`);
            throw new ExitSignal(1);
          }
          ctl.maxMessageSize = Number(size.value);
          break;
        }
        case 100: ctl.socketType = TYPE_UDP; break;
        case 84: ctl.socketType = TYPE_TCP; break;
        case 110: ctl.server = optarg; break;
        case 80: ctl.port = optarg; break;
        case OPT.OCTET_COUNT: ctl.octetCount = true; break;
        case OPT.PRIO_PREFIX: ctl.prioPrefix = true; break;
        case OPT.RFC3164: ctl.headerBuilder = rfc3164Header; break;
        case OPT.RFC5424:
          ctl.headerBuilder = rfc5424Header;
          if (optarg !== null) {
            for (const token of optarg.split(',').filter((part) => part !== '')) {
              if (token === 'notime') { ctl.rfc5424Time = false; ctl.rfc5424Tq = false; }
              else if (token === 'notq') ctl.rfc5424Tq = false;
              else if (token === 'nohost') ctl.rfc5424Host = false;
              else warnx(`ignoring unknown option argument: ${token}`);
            }
          }
          break;
        case OPT.MSGID:
          if ((optarg ?? '').includes(' ')) errx('--msgid cannot contain space');
          ctl.msgid = optarg;
          break;
        case OPT.JOURNALD:
          if (optarg !== null) {
            const file = host.readFile(optarg);
            if ('error' in file) err(`cannot open ${optarg}`, file.error);
            journalSource = { text: new TextDecoder().decode((file as { bytes: Uint8Array }).bytes) };
          } else journalSource = { text: new TextDecoder().decode(host.stdin()) };
          break;
        case OPT.SOCKET_ERRORS:
          if (optarg === 'off' || optarg === 'on' || optarg === 'auto') socketErrorsMode = optarg;
          else { warnx(`invalid argument: ${optarg}: using automatic errors`); socketErrorsMode = 'auto'; }
          break;
        case OPT.NOACT: ctl.noact = true; break;
        case OPT.SD_ID:
          if (!validStructuredId(optarg ?? '')) errx(`invalid structured data ID: '${optarg}'`);
          addStructuredId(ctl.userSds, optarg ?? '');
          break;
        case OPT.SD_PARAM:
          if (!validStructuredParam(optarg ?? '')) errx(`invalid structured data parameter: '${optarg}'`);
          addStructuredParam(ctl.userSds, optarg ?? '');
          break;
        case 86:
          out.printf(`${program} from ${LOGGER_VERSION}\n`);
          return { stdout: out.stdout, stderr: out.stderr, exitCode: 0, interleaved: out.interleaved };
        case 104:
          out.printf(USAGE(program));
          return { stdout: out.stdout, stderr: out.stderr, exitCode: 0, interleaved: out.interleaved };
        default:
          out.eprintf(`Try '${program} --help' for more information.\n`);
          throw new ExitSignal(1);
      }
    }
    const rest = getopt.argv.slice(getopt.optind);
    if (stdoutReopened && rest.length > 0) warnx('--file <file> and <message> are mutually exclusive, message is ignored');
    if (journalSource) {
      const lines: string[] = [];
      let messageLine = -1;
      for (const raw of journalSource.text.split('\n')) {
        const line = raw.replace(/[ \t\n\v\f\r]+$/, '');
        if (line.length === 0) break;
        if (line.startsWith('MESSAGE=')) {
          if (messageLine === -1) messageLine = lines.length;
          else {
            lines[messageLine] += `\n${line.slice(8)}`;
            continue;
          }
        }
        lines.push(line);
      }
      let failed = false;
      if (!ctl.noact) failed = !host.journal(lines);
      if (ctl.stderrPrintout) for (const line of lines) out.eprintf(`${line}\n`);
      if (failed) errx('journald entry could not be written');
      return { stdout: out.stdout, stderr: out.stderr, exitCode: 0, interleaved: out.interleaved };
    }
    if (hasStructuredId(ctl.userSds, 'timeQuality')) ctl.rfc5424Tq = false;
    ctl.unixSocketErrors = socketErrorsMode === 'off' ? false : socketErrorsMode === 'on' ? true : ctl.noact || ctl.stderrPrintout || host.sdBooted();

    openOnce();
    if (!ctl.headerBuilder) ctl.headerBuilder = ctl.server !== null ? rfc5424Header : localHeader;
    if (ctl.tag === null) ctl.tag = host.login();
    if (ctl.tag === null) ctl.tag = '<someone>';

    if (rest.length > 0) {
      generateHeader();
      const buffer: number[] = [];
      const limit = ctl.maxMessageSize - 1;
      for (const argument of rest) {
        const piece = bytesOf(argument);
        if (limit < buffer.length + piece.length && buffer.length > 0) {
          writeOutput(Uint8Array.from(buffer));
          buffer.length = 0;
        }
        if (ctl.maxMessageSize < piece.length) {
          writeOutput(piece.subarray(0, ctl.maxMessageSize));
          continue;
        }
        if (buffer.length > 0) buffer.push(32);
        buffer.push(...piece);
      }
      if (buffer.length > 0) writeOutput(Uint8Array.from(buffer));
    } else {
      const input = stdinOverride ?? host.stdin();
      let at = 0;
      const next = (): number => (at < input.length ? input[at++] : -1);
      const defaultPriority = ctl.pri;
      let c = next();
      while (c !== -1) {
        const line: number[] = [];
        if (ctl.prioPrefix && c === 0x3c) {
          let priority = 0;
          line.push(c);
          for (;;) {
            c = next();
            if (!(c >= 0x30 && c <= 0x39 && priority <= PRIO_MAX)) break;
            line.push(c);
            priority = priority * 10 + c - 0x30;
          }
          if (c !== -1 && c !== 10) line.push(c);
          if (c === 0x3e && priority >= 0 && priority <= PRIO_MAX) {
            line.length = 0;
            if ((priority & LOG_FACMASK) === 0) priority |= defaultPriority & LOG_FACMASK;
            ctl.pri = priority;
          } else ctl.pri = defaultPriority;
          if (c !== -1 && c !== 10) c = next();
        }
        while (c !== -1 && c !== 10 && line.length < ctl.maxMessageSize) {
          line.push(c);
          c = next();
        }
        if (line.length > 0 || !ctl.skipEmptyLines) {
          generateHeader();
          writeOutput(Uint8Array.from(line));
        }
        if (c === 10) c = next();
      }
    }
    ctl.connection?.close();
  } catch (error) {
    if (error instanceof ExitSignal) exitCode = error.code;
    else throw error;
  }
  return { stdout: out.stdout, stderr: out.stderr, exitCode, interleaved: out.interleaved };
}

const USAGE = (program: string): string => `
Usage:
 ${program} [options] [<message>]

Enter messages into the system log.

Options:
 -i                       log the logger command's PID
     --id[=<id>]          log the given <id>, or otherwise the PID
 -f, --file <file>        log the contents of this file
 -e, --skip-empty         do not log empty lines when processing files
     --no-act             do everything except the write the log
 -p, --priority <prio>    mark given message with this priority
     --octet-count        use rfc6587 octet counting
     --prio-prefix        look for a prefix on every line read from stdin
 -s, --stderr             output message to standard error as well
 -S, --size <size>        maximum size for a single message
 -t, --tag <tag>          mark every line with this tag
 -n, --server <name>      write to this remote syslog server
 -P, --port <port>        use this port for UDP or TCP connection
 -T, --tcp                use TCP only
 -d, --udp                use UDP only
     --rfc3164            use the obsolete BSD syslog protocol
     --rfc5424[=<snip>]   use the syslog protocol (the default for remote);
                            <snip> can be notime, or notq, and/or nohost
     --sd-id <id>         rfc5424 structured data ID
     --sd-param <data>    rfc5424 structured data name=value
     --msgid <msgid>      set rfc5424 message id field
 -u, --socket <socket>    write to this Unix socket
     --socket-errors[=<on|off|auto>]
                          print connection errors when using Unix sockets
     --journald[=<file>]  write journald entry

 -h, --help               display this help
 -V, --version            display version

For more details see logger(1).
`;
