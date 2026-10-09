import { cgroupPathGetOwnerUid, cgroupPathGetSession, cgroupPathGetSlice, cgroupPathGetUnit, cgroupPathGetUserSlice, cgroupPathGetUserUnit, cgroupShiftPath } from './CgroupPath';
import { fieldNameIsValid } from './JournalRecord';
import { safeAtoi } from '../systemd/SafeNumbers';
import { concat, utf8 } from './JournalText';
import { unitNameIsValid } from '../systemd/UnitName';

export interface Ucred {
  pid: number;
  uid: number;
  gid: number;
}

export interface ProcessFacts {
  uid: number | null;
  gid: number | null;
  comm: string | null;
  exe: string | null;
  cmdline: string | null;
  capeff: string | null;
  label: Uint8Array | null;
  auditId: number | null;
  loginUid: number | null;
  cgroup: string | null;
  invocationId: string | null;
}

export interface ClientContext {
  pid: number;
  uid: number | null;
  gid: number | null;
  comm: string | null;
  exe: string | null;
  cmdline: string | null;
  capeff: string | null;
  label: Uint8Array | null;
  auditId: number | null;
  loginUid: number | null;
  cgroup: string | null;
  session: string | null;
  ownerUid: number | null;
  unit: string | null;
  userUnit: string | null;
  slice: string | null;
  userSlice: string | null;
  invocationId: string | null;
}

export interface JournaldHost {
  probe(pid: number): ProcessFacts | null;
  identity(): { bootId: string; machineId: string; hostname: string };
  cgroupRoot(): string;
  write(items: Uint8Array[], priority: number): void;
  forwardSyslog?(priority: number, identifier: string | Uint8Array | null, message: Uint8Array, ucred: Ucred | null, tvUsec: number | null): void;
  forwardRawSyslog?(priority: number, raw: Uint8Array, ucred: Ucred | null): void;
  forwardKmsg?(priority: number, identifier: string | Uint8Array | null, message: Uint8Array, ucred: Ucred | null): void;
  forwardConsole?(priority: number, identifier: string | Uint8Array | null, message: Uint8Array, ucred: Ucred | null): void;
  forwardWall?(priority: number, identifier: string | Uint8Array | null, message: Uint8Array, ucred: Ucred | null): void;
  newStreamId(): string;
}

export interface JournaldSettings {
  maxLevelStore: number;
  lineMax: number;
  forwardToSyslog: boolean;
  forwardToKmsg: boolean;
  forwardToConsole: boolean;
  forwardToWall: boolean;
}

export const DEFAULT_JOURNALD_SETTINGS: JournaldSettings = {
  maxLevelStore: 7, lineMax: 48 * 1024, forwardToSyslog: false, forwardToKmsg: false, forwardToConsole: false, forwardToWall: true,
};

const LOG_PRIMASK = 7;
const LOG_FACMASK = 0x3f8;
const LOG_INFO = 6;
const LOG_USER = 8;
const NL = 0x0a;
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);
const SETUP_LINE_MAX = 255;
const ENTRY_FIELD_COUNT_MAX = 1024;

const ascii = (bytes: Uint8Array): string => String.fromCharCode(...bytes);
const field = (name: string, value: string | Uint8Array): Uint8Array => concat(utf8(`${name}=`), typeof value === 'string' ? utf8(value) : value);
const cutAtNul = (bytes: Uint8Array): Uint8Array => {
  const nul = bytes.indexOf(0);
  return nul < 0 ? bytes : bytes.subarray(0, nul);
};
const startsWith = (bytes: Uint8Array, prefix: string, at = 0): boolean => {
  for (let i = 0; i < prefix.length; i++) if (bytes[at + i] !== prefix.charCodeAt(i)) return false;
  return true;
};

export function syslogFixupFacility(priority: number): number {
  return (priority & LOG_FACMASK) === 0 ? (priority & LOG_PRIMASK) | LOG_USER : priority;
}

function undecchar(byte: number): number {
  return byte >= 0x30 && byte <= 0x39 ? byte - 0x30 : -1;
}

export function syslogParsePriority(message: Uint8Array, at: number, withFacility: boolean, current: number): { priority: number; at: number } | null {
  if (message[at] !== 0x3c) return null;
  let end = -1;
  for (let i = at; i < message.length; i++) {
    if (message[i] === 0) break;
    if (message[i] === 0x3e) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const k = end - at;
  let a = 0;
  let b = 0;
  let c = 0;
  if (k === 2) c = undecchar(message[at + 1]);
  else if (k === 3) {
    b = undecchar(message[at + 1]);
    c = undecchar(message[at + 2]);
  } else if (k === 4) {
    a = undecchar(message[at + 1]);
    b = undecchar(message[at + 2]);
    c = undecchar(message[at + 3]);
  } else return null;
  if (a < 0 || b < 0 || c < 0 || (!withFacility && (a || b || c > 7))) return null;
  const priority = withFacility ? a * 100 + b * 10 + c : (current & LOG_FACMASK) | c;
  return { priority, at: at + k + 1 };
}

function skipTimestamp(message: Uint8Array, at: number): number {
  const sequence = ['L', 'L', 'L', 'S', 'B', 'N', 'S', 'B', 'N', 'C', 'B', 'N', 'C', 'B', 'N', 'S'];
  let p = at;
  for (const kind of sequence) {
    const byte = message[p];
    if (byte === undefined || byte === 0) return 0;
    const isDigit = byte >= 0x30 && byte <= 0x39;
    const isAlpha = (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
    if (kind === 'S' && byte !== 0x20) return 0;
    if (kind === 'B' && byte !== 0x20 && !isDigit) return 0;
    if (kind === 'N' && !isDigit) return 0;
    if (kind === 'L' && !isAlpha) return 0;
    if (kind === 'C' && byte !== 0x3a) return 0;
    p++;
  }
  return p - at;
}

function parseIdentifier(message: Uint8Array, at: number): { identifier: Uint8Array; pid: string | null; at: number } | null {
  let p = at;
  while (p < message.length && WHITESPACE.has(message[p])) p++;
  let l = 0;
  while (p + l < message.length && !WHITESPACE.has(message[p + l])) l++;
  if (l <= 0 || message[p + l - 1] !== 0x3a) return null;
  const e = l;
  l--;
  let pid: string | null = null;
  if (l > 0 && message[p + l - 1] === 0x5d) {
    let k = l - 1;
    for (;;) {
      if (message[p + k] === 0x5b) {
        pid = ascii(message.subarray(p + k + 1, p + l - 1));
        l = k;
        break;
      }
      if (k === 0) break;
      k--;
    }
  }
  const identifier = message.slice(p, p + l);
  let end = e;
  if (p + e < message.length && WHITESPACE.has(message[p + e])) end++;
  return { identifier, pid, at: p + end };
}

export class StdoutStream {
  private state: 'identifier' | 'unit' | 'priority' | 'prefix' | 'syslog' | 'kmsg' | 'console' | 'running' = 'identifier';
  private identifier: string | null = null;
  private unitId: string | null = null;
  private priority = LOG_INFO;
  private levelPrefix = false;
  private forwardSyslog = false;
  private forwardKmsg = false;
  private forwardConsole = false;
  private buffer = new Uint8Array(0);
  private context: ClientContext | null = null;
  private dead = false;

  constructor(private readonly server: JournaldServer, private ucred: Ucred, private readonly label: Uint8Array | null, readonly streamId: string) {}

  get closed(): boolean {
    return this.dead;
  }

  feed(bytes: Uint8Array, ucred: Ucred | null = null): void {
    if (this.dead) return;
    if (ucred !== null && ucred.pid !== this.ucred.pid) {
      this.scan(this.buffer, 'pid-change');
      this.context = null;
      this.buffer = new Uint8Array(0);
    }
    if (ucred !== null) this.ucred = ucred;
    const data = concat(this.buffer, bytes);
    const consumed = this.scan(data, null);
    this.buffer = data.slice(consumed);
  }

  close(): void {
    if (this.dead) return;
    this.scan(this.buffer, 'eof');
    this.dead = true;
  }

  private lineMax(): number {
    return this.state === 'running' ? this.server.settings.lineMax : SETUP_LINE_MAX;
  }

  private scan(data: Uint8Array, forceFlush: LineBreak | null): number {
    let consumed = 0;
    let remaining = data.length;
    let p = 0;
    for (;;) {
      const lineMax = this.lineMax();
      const window = Math.min(remaining, lineMax);
      const newline = data.subarray(p, p + window).indexOf(NL);
      const nulWindow = newline >= 0 ? newline : window;
      const nul = data.subarray(p, p + nulWindow).indexOf(0);
      let found: number;
      let skip: number;
      let lineBreak: LineBreak;
      if (nul >= 0) {
        found = nul;
        skip = nul + 1;
        lineBreak = 'nul';
      } else if (newline >= 0) {
        found = newline;
        skip = newline + 1;
        lineBreak = 'newline';
      } else if (remaining >= lineMax) {
        found = skip = lineMax;
        lineBreak = 'line-max';
      } else break;
      if (this.found(data.subarray(p, p + found), lineBreak) < 0) {
        this.dead = true;
        return consumed + skip;
      }
      p += skip;
      consumed += skip;
      remaining -= skip;
    }
    if (forceFlush !== null && remaining > 0) {
      this.found(data.subarray(p, p + remaining), forceFlush);
      consumed += remaining;
    }
    return consumed;
  }

  private found(line: Uint8Array, lineBreak: LineBreak): number {
    let end = line.length;
    while (end > 0 && WHITESPACE.has(line[end - 1])) end--;
    const original = line.subarray(0, end);
    const stripped = new TextDecoder('utf-8').decode(original).replace(/^[ \t\n\r\v\f]+/, '');
    if (lineBreak !== 'newline' && this.state !== 'running') return -1;
    const bool = (text: string): boolean | null => {
      const lowered = text.toLowerCase();
      if (['1', 'yes', 'y', 'true', 't', 'on'].includes(lowered)) return true;
      if (['0', 'no', 'n', 'false', 'f', 'off'].includes(lowered)) return false;
      return null;
    };
    switch (this.state) {
      case 'identifier':
        if (stripped !== '') this.identifier = stripped;
        this.state = 'unit';
        return 0;
      case 'unit':
        if (this.ucred.uid === 0 && unitNameIsValid(stripped, { plain: true, instance: true })) this.unitId = stripped;
        this.state = 'priority';
        return 0;
      case 'priority': {
        const value = safeAtoi(stripped);
        if (typeof value !== 'number' || value < 0 || value > 999) return -1;
        this.priority = value;
        this.state = 'prefix';
        return 0;
      }
      case 'prefix': {
        const value = bool(stripped);
        if (value === null) return -1;
        this.levelPrefix = value;
        this.state = 'syslog';
        return 0;
      }
      case 'syslog': {
        const value = bool(stripped);
        if (value === null) return -1;
        this.forwardSyslog = value;
        this.state = 'kmsg';
        return 0;
      }
      case 'kmsg': {
        const value = bool(stripped);
        if (value === null) return -1;
        this.forwardKmsg = value;
        this.state = 'console';
        return 0;
      }
      case 'console': {
        const value = bool(stripped);
        if (value === null) return -1;
        this.forwardConsole = value;
        this.state = 'running';
        return 0;
      }
      case 'running':
        this.log(original, lineBreak);
        return 0;
    }
  }

  private log(line: Uint8Array, lineBreak: LineBreak): void {
    if (this.context === null) this.context = this.server.acquireContext(this.ucred, this.label, this.unitId);
    let priority = this.priority;
    let message = cutAtNul(line);
    if (this.levelPrefix) {
      const parsed = syslogParsePriority(message, 0, false, priority);
      if (parsed !== null) {
        priority = parsed.priority;
        message = message.subarray(parsed.at);
      }
    }
    if (message.length === 0) return;
    const server = this.server;
    if (this.forwardSyslog || server.settings.forwardToSyslog) server.host.forwardSyslog?.(syslogFixupFacility(priority), this.identifier, message, this.ucred, null);
    if (this.forwardKmsg || server.settings.forwardToKmsg) server.host.forwardKmsg?.(priority, this.identifier, message, this.ucred);
    if (this.forwardConsole || server.settings.forwardToConsole) server.host.forwardConsole?.(priority, this.identifier, message, this.ucred);
    if (server.settings.forwardToWall) server.host.forwardWall?.(priority, this.identifier, message, this.ucred);
    const items: Uint8Array[] = [utf8('_TRANSPORT=stdout'), utf8(`_STREAM_ID=${this.streamId}`), utf8(`PRIORITY=${priority & LOG_PRIMASK}`)];
    if (priority & LOG_FACMASK) items.push(utf8(`SYSLOG_FACILITY=${(priority & LOG_FACMASK) >> 3}`));
    if (this.identifier !== null) items.push(utf8(`SYSLOG_IDENTIFIER=${this.identifier}`));
    if (lineBreak !== 'newline') items.push(utf8(`_LINE_BREAK=${lineBreak}`));
    items.push(field('MESSAGE', message));
    server.dispatch(items, this.context, null, priority, 0);
  }
}

type LineBreak = 'newline' | 'nul' | 'line-max' | 'eof' | 'pid-change';

export class JournaldServer {
  constructor(readonly host: JournaldHost, readonly settings: JournaldSettings = DEFAULT_JOURNALD_SETTINGS) {}

  acquireContext(ucred: Ucred | null, label: Uint8Array | null, unitId: string | null): ClientContext | null {
    if (ucred === null || ucred.pid <= 0) return null;
    return this.readContext(ucred.pid, ucred, label, unitId);
  }

  private readContext(pid: number, ucred: Ucred | null, label: Uint8Array | null, unitId: string | null): ClientContext | null {
    const facts = this.host.probe(pid);
    const context: ClientContext = {
      pid,
      uid: ucred !== null ? ucred.uid : facts?.uid ?? null,
      gid: ucred !== null ? ucred.gid : facts?.gid ?? null,
      comm: facts?.comm ?? null,
      exe: facts?.exe ?? null,
      cmdline: facts?.cmdline ?? null,
      capeff: facts?.capeff ?? null,
      label: label !== null && label.length > 0 ? label : facts?.label ?? null,
      auditId: facts?.auditId ?? null,
      loginUid: facts?.loginUid ?? null,
      cgroup: null,
      session: null,
      ownerUid: null,
      unit: null,
      userUnit: null,
      slice: null,
      userSlice: null,
      invocationId: null,
    };
    const raw = facts?.cgroup ?? null;
    const shifted = raw === null ? null : cgroupShiftPath(raw, this.host.cgroupRoot());
    if (shifted === null || shifted === '' || shifted === '/') {
      if (unitId !== null) context.unit = unitId;
    } else {
      context.cgroup = shifted;
      context.session = cgroupPathGetSession(shifted);
      context.ownerUid = cgroupPathGetOwnerUid(shifted);
      context.unit = cgroupPathGetUnit(shifted);
      context.userUnit = cgroupPathGetUserUnit(shifted);
      context.slice = cgroupPathGetSlice(shifted);
      context.userSlice = cgroupPathGetUserSlice(shifted);
    }
    if (context.unit !== null) context.invocationId = facts?.invocationId ?? null;
    return context;
  }

  dispatch(items: Uint8Array[], context: ClientContext | null, tvUsec: number | null, priority: number, objectPid: number): void {
    if ((priority & LOG_PRIMASK) > this.settings.maxLevelStore) return;
    const out = items.slice();
    const add = (name: string, value: string | number | null): void => {
      if (value === null || value === '') return;
      out.push(field(name, String(value)));
    };
    if (context !== null) {
      add('_PID', context.pid > 0 ? context.pid : null);
      add('_UID', context.uid);
      add('_GID', context.gid);
      add('_COMM', context.comm);
      add('_EXE', context.exe);
      add('_CMDLINE', context.cmdline);
      add('_CAP_EFFECTIVE', context.capeff);
      if (context.label !== null && context.label.length > 0) out.push(field('_SELINUX_CONTEXT', context.label));
      add('_AUDIT_SESSION', context.auditId);
      add('_AUDIT_LOGINUID', context.loginUid);
      add('_SYSTEMD_CGROUP', context.cgroup);
      add('_SYSTEMD_SESSION', context.session);
      add('_SYSTEMD_OWNER_UID', context.ownerUid);
      add('_SYSTEMD_UNIT', context.unit);
      add('_SYSTEMD_USER_UNIT', context.userUnit);
      add('_SYSTEMD_SLICE', context.slice);
      add('_SYSTEMD_USER_SLICE', context.userSlice);
      add('_SYSTEMD_INVOCATION_ID', context.invocationId);
    }
    if (objectPid > 0) {
      const object = this.readContext(objectPid, null, null, null);
      if (object !== null) {
        add('OBJECT_PID', object.pid);
        add('OBJECT_UID', object.uid);
        add('OBJECT_GID', object.gid);
        add('OBJECT_COMM', object.comm);
        add('OBJECT_EXE', object.exe);
        add('OBJECT_CMDLINE', object.cmdline);
        add('OBJECT_CAP_EFFECTIVE', object.capeff);
        if (object.label !== null && object.label.length > 0) out.push(field('OBJECT_SELINUX_CONTEXT', object.label));
        add('OBJECT_AUDIT_SESSION', object.auditId);
        add('OBJECT_AUDIT_LOGINUID', object.loginUid);
        add('OBJECT_SYSTEMD_CGROUP', object.cgroup);
        add('OBJECT_SYSTEMD_SESSION', object.session);
        add('OBJECT_SYSTEMD_OWNER_UID', object.ownerUid);
        add('OBJECT_SYSTEMD_UNIT', object.unit);
        add('OBJECT_SYSTEMD_USER_UNIT', object.userUnit);
        add('OBJECT_SYSTEMD_SLICE', object.slice);
        add('OBJECT_SYSTEMD_USER_SLICE', object.userSlice);
        add('OBJECT_SYSTEMD_INVOCATION_ID=', object.invocationId);
      }
    }
    if (tvUsec !== null) out.push(utf8(`_SOURCE_REALTIME_TIMESTAMP=${tvUsec}`));
    const identity = this.host.identity();
    out.push(utf8(`_BOOT_ID=${identity.bootId}`), utf8(`_MACHINE_ID=${identity.machineId}`), utf8(`_HOSTNAME=${identity.hostname}`), utf8('_RUNTIME_SCOPE=system'));
    this.host.write(out, priority);
  }

  processNative(buffer: Uint8Array, ucred: Ucred | null, tvUsec: number | null, label: Uint8Array | null): void {
    const context = ucred !== null && ucred.pid > 0 ? this.readContext(ucred.pid, ucred, label, null) : null;
    const cursor = { at: 0, remaining: buffer.length };
    while (this.processEntry(buffer, cursor, context, ucred, tvUsec) === 0);
  }

  private processEntry(buffer: Uint8Array, cursor: { at: number; remaining: number }, context: ClientContext | null, ucred: Ucred | null, tvUsec: number | null): number {
    const items: Uint8Array[] = [];
    let priority = LOG_INFO;
    let identifier: string | null = null;
    let message: Uint8Array | null = null;
    let objectPid = 0;
    const meta = (data: Uint8Array): void => {
      const l = data.length;
      if (l === 10 && startsWith(data, 'PRIORITY=') && data[9] >= 0x30 && data[9] <= 0x39) priority = (priority & LOG_FACMASK) | (data[9] - 0x30);
      else if (l === 17 && startsWith(data, 'SYSLOG_FACILITY=') && data[16] >= 0x30 && data[16] <= 0x39) priority = (priority & LOG_PRIMASK) | ((data[16] - 0x30) << 3);
      else if (l === 18 && startsWith(data, 'SYSLOG_FACILITY=') && data[16] >= 0x30 && data[16] <= 0x39 && data[17] >= 0x30 && data[17] <= 0x39) {
        priority = (priority & LOG_PRIMASK) | (((data[16] - 0x30) * 10 + (data[17] - 0x30)) << 3);
      } else if (l >= 19 && startsWith(data, 'SYSLOG_IDENTIFIER=')) identifier = new TextDecoder('utf-8').decode(cutAtNul(data.subarray(18)));
      else if (l >= 8 && startsWith(data, 'MESSAGE=')) message = cutAtNul(data.subarray(8));
      else if (l > 11 && l < 11 + 12 && startsWith(data, 'OBJECT_PID=') && ucred !== null && ucred.uid === 0) {
        const digits = ascii(data.subarray(11));
        if (/^[0-9]+$/.test(digits) && Number(digits) > 0) objectPid = Number(digits);
      }
    };
    while (cursor.remaining > 0) {
      const base = cursor.at;
      let e = -1;
      for (let i = base; i < base + cursor.remaining; i++) if (buffer[i] === NL) { e = i; break; }
      if (e < 0) break;
      if (e === base) {
        cursor.at += 1;
        cursor.remaining -= 1;
        break;
      }
      if (buffer[base] === 0x2e || buffer[base] === 0x23) {
        cursor.remaining -= e - base + 1;
        cursor.at = e + 1;
        continue;
      }
      if (items.length > ENTRY_FIELD_COUNT_MAX) return 1;
      let q = -1;
      for (let i = base; i < e; i++) if (buffer[i] === 0x3d) { q = i; break; }
      if (q >= 0) {
        if (fieldNameIsValid(ascii(buffer.subarray(base, q)), false)) {
          const data = buffer.slice(base, e);
          items.push(data);
          meta(data);
        }
        cursor.remaining -= e - base + 1;
        cursor.at = e + 1;
        continue;
      }
      if (cursor.remaining < e - base + 1 + 8 + 1) break;
      const length = Number(new DataView(buffer.buffer, buffer.byteOffset + e + 1, 8).getBigUint64(0, true));
      if (cursor.remaining < e - base + 1 + 8 + length + 1 || buffer[e + 1 + 8 + length] !== NL) break;
      const name = ascii(buffer.subarray(base, e));
      if (fieldNameIsValid(name, false)) {
        const data = concat(buffer.subarray(base, e), Uint8Array.of(0x3d), buffer.subarray(e + 1 + 8, e + 1 + 8 + length));
        items.push(data);
        meta(data);
      }
      cursor.remaining -= e - base + 1 + 8 + length + 1;
      cursor.at = e + 1 + 8 + length + 1;
    }
    if (items.length === 0) return 1;
    items.push(utf8('_TRANSPORT=journal'));
    const text = message as Uint8Array | null;
    if (text !== null) {
      if (this.settings.forwardToSyslog) this.host.forwardSyslog?.(syslogFixupFacility(priority), identifier, text, ucred, tvUsec);
      if (this.settings.forwardToKmsg) this.host.forwardKmsg?.(priority, identifier, text, ucred);
      if (this.settings.forwardToConsole) this.host.forwardConsole?.(priority, identifier, text, ucred);
      if (this.settings.forwardToWall) this.host.forwardWall?.(priority, identifier, text, ucred);
    }
    this.dispatch(items, context, tvUsec, priority, objectPid);
    return text === null ? 0 : 1;
  }

  processSyslog(buf: Uint8Array, ucred: Ucred | null, tvUsec: number | null, label: Uint8Array | null): void {
    const rawLength = buf.length;
    if (rawLength === 0) return;
    const context = ucred !== null && ucred.pid > 0 ? this.readContext(ucred.pid, ucred, label, null) : null;
    let i = rawLength;
    while (i > 0 && (WHITESPACE.has(buf[i - 1]) || buf[i - 1] === 0)) i--;
    let leading = 0;
    while (leading < rawLength && WHITESPACE.has(buf[leading])) leading++;
    let message: Uint8Array;
    let sameAsBuffer = false;
    if (i === 0) message = new Uint8Array(0);
    else if (i === rawLength) {
      message = cutAtNul(buf.subarray(leading));
      sameAsBuffer = leading === 0;
    } else message = cutAtNul(buf.subarray(leading, i));
    let storeRaw = !sameAsBuffer || message.length !== rawLength;
    let at = 0;
    let priority = LOG_USER | LOG_INFO;
    const parsed = syslogParsePriority(message, at, true, priority);
    if (parsed !== null) {
      priority = parsed.priority;
      at = parsed.at;
    }
    const timestampStart = at;
    const timestampLength = skipTimestamp(message, at);
    if (timestampLength === 0) storeRaw = true;
    else at += timestampLength;
    let identifier: Uint8Array | null = null;
    let pid: string | null = null;
    const identified = parseIdentifier(message, at);
    if (identified !== null) {
      identifier = identified.identifier;
      pid = identified.pid;
      at = identified.at;
    }
    const body = message.subarray(at);
    if (this.settings.forwardToSyslog) this.host.forwardRawSyslog?.(priority, buf, ucred);
    if (this.settings.forwardToKmsg) this.host.forwardKmsg?.(priority, identifier, body, ucred);
    if (this.settings.forwardToConsole) this.host.forwardConsole?.(priority, identifier, body, ucred);
    if (this.settings.forwardToWall) this.host.forwardWall?.(priority, identifier, body, ucred);
    const items: Uint8Array[] = [utf8('_TRANSPORT=syslog'), utf8(`PRIORITY=${priority & LOG_PRIMASK}`)];
    if (priority & LOG_FACMASK) items.push(utf8(`SYSLOG_FACILITY=${(priority & LOG_FACMASK) >> 3}`));
    if (identifier !== null) items.push(field('SYSLOG_IDENTIFIER', identifier));
    if (pid !== null) items.push(utf8(`SYSLOG_PID=${pid}`));
    if (timestampLength > 0) items.push(field('SYSLOG_TIMESTAMP', message.subarray(timestampStart, timestampStart + timestampLength)));
    items.push(field('MESSAGE', body));
    if (storeRaw) items.push(field('SYSLOG_RAW', buf));
    this.dispatch(items, context, tvUsec, priority, 0);
  }

  openStdoutStream(ucred: Ucred, label: Uint8Array | null): StdoutStream {
    return new StdoutStream(this, ucred, label, this.host.newStreamId());
  }

  driverMessage(messageId: string | null, message: string, extra: Array<[string, string]> = []): void {
    const items: Uint8Array[] = [utf8('SYSLOG_FACILITY=3'), utf8('SYSLOG_IDENTIFIER=systemd-journald'), utf8('_TRANSPORT=driver'), utf8('PRIORITY=6')];
    if (messageId !== null) items.push(utf8(`MESSAGE_ID=${messageId}`));
    items.push(utf8(`MESSAGE=${message}`));
    for (const [name, value] of extra) items.push(utf8(`${name}=${value}`));
    this.dispatch(items, this.selfContext, null, LOG_INFO, 0);
  }

  selfContext: ClientContext | null = null;
}
