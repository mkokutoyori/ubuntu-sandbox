import { AUDIT_RANGES } from './AuditMessageTypes';
import {
  AVC_DENIED, AVC_GRANTED, StringList, newAvcNode, type AvcNode,
} from './AuditLists';
import {
  isDigit, isHexDigit, strchr, strstr, strtoul, toInt32, toUint32, unescapeHex,
} from './AuditCString';
import { AUDIT } from './AuditConstants';

export const S_UNSET = -1;
export const S_FAILED = 0;
export const S_SUCCESS = 1;
export const UID_UNSET = 0xffffffff;
export const LOGINUID_UNSET = 0xfffffffe;
export const KEY_SEPARATOR = String.fromCharCode(0x01);
const NAME_OFFSET = 28;

export interface SearchFlags {
  eventPid: number;
  eventPpid: number;
  eventUid: number;
  eventEuid: number;
  eventLoginuid: number;
  eventGid: number;
  eventEgid: number;
  eventTuid: string | null;
  eventTeuid: string | null;
  eventTauid: string | null;
  eventKey: string | null;
  eventFilename: string | null;
  eventExe: string | null;
  eventComm: string | null;
  eventHostname: string | null;
  eventTerminal: string | null;
  eventSubject: string | null;
  eventObject: string | null;
  eventUuid: string | null;
  eventVmname: string | null;
  eventSuccess: number;
  eventSessionId: number;
  eventExitIsSet: boolean;
  eventMachine: number;
  reportDefault: boolean;
}

export function defaultSearchFlags(): SearchFlags {
  return {
    eventPid: 0, eventPpid: -1, eventUid: -1, eventEuid: -1, eventLoginuid: -2, eventGid: -1, eventEgid: -1,
    eventTuid: null, eventTeuid: null, eventTauid: null, eventKey: null, eventFilename: null, eventExe: null,
    eventComm: null, eventHostname: null, eventTerminal: null, eventSubject: null, eventObject: null,
    eventUuid: null, eventVmname: null, eventSuccess: S_SUCCESS, eventSessionId: -2, eventExitIsSet: false,
    eventMachine: -1, reportDefault: true,
  };
}

export interface SearchItems {
  ppid: number;
  pid: number;
  uid: number;
  euid: number;
  loginuid: number;
  gid: number;
  egid: number;
  success: number;
  arch: number;
  syscall: number;
  sessionId: number;
  exit: number;
  exitIsSet: boolean;
  hostname: string | null;
  filename: StringList | null;
  cwd: string | null;
  exe: string | null;
  key: StringList | null;
  terminal: string | null;
  comm: string | null;
  avc: AvcNode[] | null;
  acct: string | null;
  uuid: string | null;
  vmname: string | null;
  tuid: string | null;
  teuid: string | null;
  tauid: string | null;
}

export function newSearchItems(): SearchItems {
  return {
    ppid: -1, pid: -1, uid: UID_UNSET, euid: UID_UNSET, loginuid: LOGINUID_UNSET, gid: UID_UNSET, egid: UID_UNSET,
    success: S_UNSET, arch: 0, syscall: 0, sessionId: toUint32(-2), exit: 0, exitIsSet: false,
    hostname: null, filename: null, cwd: null, exe: null, key: null, terminal: null, comm: null, avc: null,
    acct: null, uuid: null, vmname: null, tuid: null, teuid: null, tauid: null,
  };
}

export interface AuditEventTime {
  sec: number;
  milli: number;
  serial: number;
  node: string | null;
  type: number;
}

export interface AuditRecordNode {
  message: string;
  type: number;
  a0: bigint;
  a1: bigint;
  item: number;
}

export class AuditEvent {
  readonly records: AuditRecordNode[] = [];
  readonly e: AuditEventTime;
  s: SearchItems = newSearchItems();

  constructor(e: AuditEventTime) {
    this.e = e;
  }

  get head(): AuditRecordNode | null {
    return this.records[0] ?? null;
  }

  get count(): number {
    return this.records.length;
  }

  append(node: Omit<AuditRecordNode, 'item'>): void {
    this.records.push({ ...node, item: this.records.length });
  }

  hasType(type: number): boolean {
    return this.records.some((r) => r.type === type);
  }

  hasTypeRange(low: number, high: number): boolean {
    if (high <= low) return false;
    return this.records.some((r) => r.type >= low && r.type <= high);
  }
}

export interface ParseEnvironment {
  userName(uid: number): string | null;
  flags: SearchFlags;
  debug?: (message: string) => void;
}

function lookupUid(env: ParseEnvironment, uid: number): string | null {
  if (uid === 0) return 'root';
  if (uid === UID_UNSET) return 'unset';
  return env.userName(uid);
}

function pushAvc(s: SearchItems, node: AvcNode): void {
  s.avc ??= [];
  s.avc.push(node);
}

function pushString(list: StringList | null, str: string, key: string | null = null): StringList {
  const target = list ?? new StringList();
  target.append({ str, key, hits: 1 });
  return target;
}

function parseKeyField(msg: string, at: number, s: SearchItems): number {
  if (msg[at] === '"') {
    const close = strchr(msg, at + 1, '"');
    if (close < 0) return -1;
    s.key = pushString(s.key, msg.slice(at + 1, close));
    return close;
  }
  const decoded = unescapeHex(msg, at);
  if (decoded === null) return -2;
  for (const part of decoded.split(KEY_SEPARATOR)) {
    if (part !== '') s.key = pushString(s.key, part);
  }
  return at;
}

function commonPathParser(s: SearchItems, msg: string, pathAt: number): number {
  let str: string;
  const tail = msg.slice(pathAt);
  if (tail[0] === '"') {
    const close = tail.indexOf('"', 1);
    if (close < 0) return 2;
    str = tail.slice(1, close);
  } else {
    if (tail.startsWith('(null)')) {
      str = '(null)';
    } else {
      if (!isHexDigit(tail[0])) return 4;
      let decoded: string | null;
      if (tail[0] === '0' && tail[1] === '0') {
        decoded = unescapeHex(tail, 2);
      } else {
        const space = tail.indexOf(' ');
        if (space < 0) return 5;
        decoded = unescapeHex(tail.slice(0, space), 0);
      }
      if (decoded === null) return 7;
      str = decoded;
    }
  }
  if (tail[0] !== '(' && str[0] === '.' && (str[1] === '.' || str[1] === '/') && s.cwd) {
    str = `${s.cwd}/${str}`;
  }
  s.filename = pushString(s.filename, str);
  return 0;
}

function parseTaskInfo(msg: string, type: number, s: SearchItems, env: ParseEnvironment): number {
  const f = env.flags;
  let term = 0;
  if (f.eventPpid !== -1) {
    const str = strstr(msg, term, 'ppid=');
    if (str >= 0) {
      const ptr = str + 5;
      const t = strchr(msg, ptr, ' ');
      if (t < 0) return 14;
      s.ppid = toInt32(strtoul(msg.slice(ptr, t)));
      term = t;
    }
  }
  if (f.eventPid !== -1) {
    const str = strstr(msg, term, ' pid=');
    if (str < 0) return 16;
    const ptr = str + 5;
    const t = strchr(msg, ptr, ' ');
    if (t < 0) return 17;
    s.pid = toInt32(strtoul(msg.slice(ptr, t)));
    term = t;
  }
  if (f.eventLoginuid !== -2 || f.eventTauid) {
    let str = strstr(msg, term, 'auid=');
    let ptr: number;
    if (str < 0) {
      str = strstr(msg, term, 'loginuid=');
      if (str < 0) return 19;
      ptr = str + 9;
    } else ptr = str + 5;
    const t = strchr(msg, ptr, ' ');
    if (t < 0) return 20;
    s.loginuid = toUint32(strtoul(msg.slice(ptr, t)));
    term = t;
    s.tauid = lookupUid(env, s.loginuid);
  }
  if (f.eventUid !== -1 || f.eventTuid) {
    let str: number;
    for (;;) {
      str = strstr(msg, term, 'uid=');
      if (str < 0) return 22;
      if (msg[str - 1] === 'a') { term = str + 1; continue; }
      break;
    }
    const ptr = str + 4;
    const t = strchr(msg, ptr, ' ');
    if (t < 0) return 23;
    s.uid = toUint32(strtoul(msg.slice(ptr, t)));
    term = t;
    s.tuid = lookupUid(env, s.uid);
  }
  if (f.eventGid !== -1) {
    const str = strstr(msg, term, 'gid=');
    if (str < 0) return 25;
    const ptr = str + 4;
    const t = strchr(msg, ptr, ' ');
    if (t < 0) return 26;
    s.gid = toUint32(strtoul(msg.slice(ptr, t)));
    term = t;
  }
  if (f.eventEuid !== -1 || f.eventTeuid) {
    const str = strstr(msg, term, 'euid=');
    if (str < 0) return 28;
    const ptr = str + 5;
    const t = strchr(msg, ptr, ' ');
    if (t < 0) return 29;
    s.euid = toUint32(strtoul(msg.slice(ptr, t)));
    term = t;
    s.teuid = lookupUid(env, s.euid);
  }
  if (f.eventEgid !== -1) {
    const str = strstr(msg, term, 'egid=');
    if (str < 0) return 31;
    const ptr = str + 5;
    const t = strchr(msg, ptr, ' ');
    if (t < 0) return 32;
    s.egid = toUint32(strtoul(msg.slice(ptr, t)));
    term = t;
  }
  if (f.eventTerminal) {
    const str = strstr(msg, term, 'tty=');
    if (str >= 0) {
      const t = strchr(msg, str + 4, ' ');
      if (t < 0) return 34;
      s.terminal = msg.slice(str + 4, t);
      term = t;
    }
  }
  if (f.eventSessionId !== -2) {
    const str = strstr(msg, term, 'ses=');
    if (str >= 0) {
      const ptr = str + 4;
      const t = strchr(msg, ptr, ' ');
      if (t < 0) return 35;
      s.sessionId = toUint32(strtoul(msg.slice(ptr, t)));
      term = t;
    }
  }
  if (f.eventComm) {
    const str = strstr(msg, term, 'comm=');
    if (str >= 0) {
      s.comm = null;
      const at = str + 5;
      if (msg[at] === '"') {
        const close = strchr(msg, at + 1, '"');
        if (close < 0) return 37;
        s.comm = msg.slice(at + 1, close);
        term = close;
      } else s.comm = unescapeHex(msg, at);
    } else return 38;
  }
  if (f.eventExe) {
    const str = strstr(msg, 0, 'exe=');
    if (str >= 0) {
      const at = str + 4;
      if (msg[at] === '"') {
        const close = strchr(msg, at + 1, '"');
        if (close < 0) return 39;
        s.exe = msg.slice(at + 1, close);
      } else s.exe = unescapeHex(msg, at);
    } else return 40;
  }
  if (f.eventSubject) {
    const str = strstr(msg, term, 'subj=');
    if (str >= 0) {
      const at = str + 5;
      const t = strchr(msg, at, ' ');
      if (t < 0) return 41;
      pushAvc(s, { ...newAvcNode(), scontext: msg.slice(at, t) });
      term = t;
    }
  }
  if (f.eventSuccess !== S_UNSET) {
    const start = term;
    const str = strstr(msg, start, 'res=');
    if (str >= 0) {
      const ptr = str + 4;
      s.success = strtoul(msg.slice(ptr));
    }
  }
  return 0;
}

function parseSyscall(msg: string, type: number, s: SearchItems, env: ParseEnvironment, node: AuditRecordNode): number {
  const f = env.flags;
  let term = 0;
  if ((!f.reportDefault || f.eventMachine !== -1) && type === AUDIT.SYSCALL) {
    const str = strstr(msg, term, 'arch=');
    if (str < 0) return 1;
    const ptr = str + 5;
    const t = strchr(msg, ptr, ' ');
    if (t < 0) return 2;
    s.arch = toInt32(strtoul(msg.slice(ptr, t), 16));
    term = t;
  }
  let str: number;
  if (type === AUDIT.SYSCALL) str = strstr(msg, term, 'syscall=');
  else if (type === AUDIT.URINGOP) { str = strstr(msg, term, 'uring_op='); s.arch = -2; }
  else str = -1;
  if (str < 0) return 4;
  let ptr = str + 8;
  let t = strchr(msg, ptr, ' ');
  if (t < 0) return 5;
  s.syscall = toInt32(strtoul(msg.slice(ptr, t)));
  term = t;
  if (f.eventSuccess !== S_UNSET) {
    const sx = strstr(msg, term, 'success=');
    if (sx >= 0) {
      ptr = sx + 8;
      t = strchr(msg, ptr, ' ');
      if (t < 0) return 7;
      s.success = msg.slice(ptr, t) === 'yes' ? S_SUCCESS : S_FAILED;
      term = t;
    }
  }
  if (f.eventExitIsSet) {
    const ex = strstr(msg, term, 'exit=');
    if (ex < 0) return 8;
    ptr = ex + 5;
    t = strchr(msg, ptr, ' ');
    if (t < 0) return 9;
    s.exit = Number(msg.slice(ptr, t)) || 0;
    s.exitIsSet = true;
    term = t;
  }
  if (type === AUDIT.SYSCALL) {
    for (const [name, assign] of [['a0=', (v: bigint) => { node.a0 = v; }], ['a1=', (v: bigint) => { node.a1 = v; }]] as const) {
      const a = strstr(msg, term, name);
      if (a < 0) return 11;
      ptr = a + 3;
      t = strchr(msg, ptr, ' ');
      if (t < 0) return 12;
      const digits = /^[0-9a-fA-F]+/.exec(msg.slice(ptr, t));
      assign(digits ? BigInt('0x' + digits[0]) : 0n);
      term = t;
    }
  }
  const ret = parseTaskInfo(msg.slice(0), type, s, env);
  if (ret) return ret;

  if (f.eventKey) {
    const k = strstr(msg, term, 'key=');
    if (k >= 0) {
      const code = parseKeyField(msg, k + 4, s);
      if (code === -1) return 44;
      if (code === -2) return 45;
    }
  }
  return 0;
}

function parseDir(msg: string, s: SearchItems, env: ParseEnvironment): number {
  if (env.flags.eventFilename) {
    const str = strstr(msg, NAME_OFFSET, ' cwd=');
    if (str >= 0) {
      const at = str + 5;
      if (msg[at] === '"') {
        const close = strchr(msg, at + 1, '"');
        if (close < 0) return 1;
        if (!s.cwd) s.cwd = msg.slice(at + 1, close);
      } else if (!s.cwd) s.cwd = unescapeHex(msg, at);
    }
  }
  return 0;
}

function avcParsePath(msg: string, s: SearchItems, env: ParseEnvironment): number {
  if (env.flags.eventFilename) {
    const str = strstr(msg, 0, ' path=');
    if (str >= 0) return commonPathParser(s, msg, str + 6);
    return 1;
  }
  return 0;
}

function parsePath(msg: string, s: SearchItems, env: ParseEnvironment): number {
  const f = env.flags;
  let term = NAME_OFFSET;
  if (f.eventFilename) {
    const str = strstr(msg, term, ' name=');
    if (str >= 0) {
      const at = str + 6;
      const rc = commonPathParser(s, msg, at);
      if (rc) return rc;
      term = at;
      const t = strstr(msg, term, 'type=');
      if (t >= 0 && s.filename) {
        const last = s.filename.nodes[s.filename.nodes.length - 1];
        last.key = msg.slice(t + 5);
      }
    }
  }
  if (f.eventObject) {
    const str = strstr(msg, term, 'obj=');
    if (str >= 0) {
      const at = str + 4;
      const t = strchr(msg, at, ' ');
      pushAvc(s, { ...newAvcNode(), tcontext: t < 0 ? msg.slice(at) : msg.slice(at, t) });
    }
  }
  return 0;
}

function parseObj(msg: string, s: SearchItems, env: ParseEnvironment): number {
  if (env.flags.eventObject) {
    const str = strstr(msg, 0, 'obj=');
    if (str >= 0) {
      const at = str + 4;
      const t = strchr(msg, at, ' ');
      pushAvc(s, { ...newAvcNode(), tcontext: t < 0 ? msg.slice(at) : msg.slice(at, t) });
    }
  }
  return 0;
}

function legacyOrHex(msg: string, at: number): { value: string | null; term: number } {
  let end = at;
  let legacy = false;
  while (end < msg.length && msg[end] !== ' ') {
    if (!isHexDigit(msg[end])) legacy = true;
    end++;
  }
  return { value: legacy ? msg.slice(at, end) : unescapeHex(msg, at), term: end };
}

function parseUser(msg: string, type: number, s: SearchItems, env: ParseEnvironment, avc: AvcNode | null): number {
  const f = env.flags;
  let term = 0;
  if (f.eventPid !== -1) {
    const str = strstr(msg, term, 'pid=');
    if (str < 0) return 1;
    const ptr = str + 4;
    const t = strchr(msg, ptr, ' ');
    if (t < 0) return 2;
    s.pid = toInt32(strtoul(msg.slice(ptr, t)));
    term = t;
  }
  if (f.eventUid !== -1 || f.eventTuid) {
    const str = strstr(msg, term, 'uid=');
    if (str < 0) return 4;
    const ptr = str + 4;
    const t = strchr(msg, ptr, ' ');
    if (t < 0) return 5;
    s.uid = toUint32(strtoul(msg.slice(ptr, t)));
    term = t;
    s.tuid = lookupUid(env, s.uid);
  }
  if (f.eventLoginuid !== -2 || f.eventTauid) {
    let str = strstr(msg, term, 'auid=');
    let ptr: number;
    if (str < 0) {
      str = strstr(msg, term, 'loginuid=');
      if (str < 0) return 7;
      ptr = str + 9;
    } else ptr = str + 5;
    const t = strchr(msg, ptr, ' ');
    if (t < 0) return 8;
    s.loginuid = toUint32(strtoul(msg.slice(ptr, t)));
    term = t;
    s.tauid = lookupUid(env, s.loginuid);
  }
  if (f.eventSessionId !== -2) {
    const str = strstr(msg, term, 'ses=');
    if (str >= 0) {
      const ptr = str + 4;
      const t = strchr(msg, ptr, ' ');
      if (t < 0) return 10;
      s.sessionId = toUint32(strtoul(msg.slice(ptr, t)));
      term = t;
    }
  }
  if (f.eventSubject) {
    const str = strstr(msg, term, 'subj=');
    if (str >= 0) {
      const at = str + 5;
      const t = strchr(msg, at, ' ');
      if (t < 0) return 12;
      if (avc) avc.scontext = msg.slice(at, t);
      else pushAvc(s, { ...newAvcNode(), scontext: msg.slice(at, t) });
      term = t;
    }
  }
  if (avc && f.eventObject) {
    const str = strstr(msg, term, 'tcontext=');
    if (str >= 0) {
      const at = str + 9;
      const t = strchr(msg, at, ' ');
      if (t >= 0) { avc.tcontext = msg.slice(at, t); term = t; } else term = at;
    }
    const cls = strstr(msg, term, 'tclass=');
    if (cls >= 0) {
      const at = cls + 7;
      const t = strchr(msg, at, ' ');
      if (t >= 0) { avc.avcClass = msg.slice(at, t); term = t; } else term = at;
    }
  }
  if (f.eventGid !== -1) {
    if (type === AUDIT.ADD_GROUP || type === AUDIT.DEL_GROUP || type === AUDIT.GRP_MGMT) {
      let str = strstr(msg, term, ' id=');
      if (str < 0 && type === AUDIT.GRP_MGMT) str = strstr(msg, term, 'gid=');
      if (str >= 0) {
        const ptr = str + 4;
        const t = strchr(msg, ptr, ' ');
        if (t < 0) return 31;
        s.gid = toUint32(strtoul(msg.slice(ptr, t)));
        term = t;
      }
    }
  }
  if (f.eventVmname) {
    const str = strstr(msg, term, 'vm=');
    if (str >= 0) {
      const at = str + 3;
      if (msg[at] === '"') {
        const close = strchr(msg, at + 1, '"');
        if (close < 0) return 23;
        s.vmname = msg.slice(at + 1, close);
        term = close;
      } else s.vmname = unescapeHex(msg, at);
    }
  }
  if (f.eventUuid) {
    const str = strstr(msg, term, 'uuid=');
    if (str >= 0) {
      const at = str + 5;
      let t = at;
      while (t < msg.length && msg[t] !== ' ' && msg[t] !== ':') t++;
      if (t === at) return 24;
      s.uuid = msg.slice(at, t);
      term = t;
    }
  }
  if (type === AUDIT.VIRT_MACHINE_ID) {
    if (f.eventSubject) {
      const str = strstr(msg, term, 'vm-ctx=');
      if (str >= 0) {
        const at = str + 7;
        const t = strchr(msg, at, ' ');
        if (t < 0) return 27;
        pushAvc(s, { ...newAvcNode(), scontext: msg.slice(at, t) });
        term = t;
      }
    }
    if (f.eventObject) {
      const str = strstr(msg, term, 'img-ctx=');
      if (str >= 0) {
        const at = str + 8;
        const t = strchr(msg, at, ' ');
        if (t < 0) return 29;
        pushAvc(s, { ...newAvcNode(), tcontext: msg.slice(at, t) });
        term = t;
      }
    }
  } else if (type === AUDIT.VIRT_RESOURCE) {
    if (f.eventFilename) {
      let incr = 6;
      let str = strstr(msg, term, ' path=');
      if (str < 0) { incr = 10; str = strstr(msg, term, ' new-disk='); }
      if (str >= 0) {
        const rc = commonPathParser(s, msg, str + incr);
        if (rc) return rc;
        term = str + incr;
      }
    }
  }
  let skipped = false;
  if (f.eventUid !== -1 || f.eventTuid) {
    for (;;) {
      const str = strstr(msg, term, 'uid=');
      if (str < 0) break;
      if (msg[str - 1] === 'a') { term = str + 1; continue; }
      if (msg[str - 1] === 's' || msg[str - 1] === 'u') { skipped = true; break; }
      if (!(msg[str - 1] === "'" || msg[str - 1] === ' ')) return 25;
      const ptr = str + 4;
      let t = ptr;
      while (isDigit(msg[t])) t++;
      if (t === ptr) return 14;
      s.uid = toUint32(strtoul(msg.slice(ptr, t)));
      term = t;
      s.tuid = lookupUid(env, s.uid);
      break;
    }
  }
  void skipped;
  let mptr = term;
  if (f.eventComm) {
    const str = strstr(msg, mptr, 'comm=');
    if (str >= 0) {
      const at = str + 5;
      if (msg[at] === '"') {
        const close = strchr(msg, at + 1, '"');
        if (close < 0) return 16;
        s.comm = msg.slice(at + 1, close);
        term = close;
      } else s.comm = unescapeHex(msg, at);
    }
  }
  const acct = strstr(msg, mptr, 'acct=');
  if (acct >= 0) {
    const ptr = acct + 5;
    term = ptr + 1;
    if (msg[ptr] === '"') {
      while (term < msg.length && msg[term] !== '"') term++;
      if (!s.acct) s.acct = msg.slice(ptr + 1, term);
    } else {
      const res = legacyOrHex(msg, ptr);
      term = res.term;
      s.acct = res.value;
    }
  }
  mptr = term;
  if (f.eventHostname) {
    const str = strstr(msg, mptr, 'hostname=');
    if (str >= 0) {
      const at = str + 9;
      let t = strchr(msg, at, ',');
      if (t < 0) {
        t = strchr(msg, at, ' ');
        if (t < 0) return 17;
      }
      s.hostname = msg.slice(at, t);
      if (s.hostname === '?') {
        const a = strstr(msg, t + 1, 'addr=');
        if (a >= 0) {
          const addrAt = a + 5;
          let e = strchr(msg, addrAt, ',');
          if (e < 0) {
            e = strchr(msg, addrAt, ' ');
            if (e < 0) return 18;
          }
          s.hostname = msg.slice(addrAt, e);
        }
      }
    }
  }
  if (f.eventFilename) {
    const str = strstr(msg, mptr, 'cwd=');
    if (str >= 0) {
      const at = str + 4;
      if (msg[at] === '"') {
        const close = strchr(msg, at + 1, '"');
        if (close < 0) return 20;
        s.cwd = msg.slice(at + 1, close);
        term = close;
      } else {
        const res = legacyOrHex(msg, at);
        s.cwd = res.value;
        term = res.term;
      }
    }
  }
  if (f.eventTerminal) {
    const str = strstr(msg, mptr, 'terminal=');
    if (str >= 0) {
      const at = str + 9;
      let t = strchr(msg, at, ' ');
      if (t < 0) {
        t = strchr(msg, at, ')');
        if (t < 0) return 19;
      }
      s.terminal = msg.slice(at, t);
    }
  }
  if (f.eventExe) {
    const str = strstr(msg, mptr, 'exe=');
    if (str >= 0) {
      const at = str + 4;
      if (msg[at] === '"') {
        const close = strchr(msg, at + 1, '"');
        if (close < 0) return 26;
        s.exe = msg.slice(at + 1, close);
        term = close;
      } else {
        const res = legacyOrHex(msg, at);
        s.exe = res.value;
        term = res.term;
      }
    }
  }
  if (f.eventSuccess !== S_UNSET) {
    const str = strstr(msg, mptr, 'res=');
    if (str >= 0) {
      const ptr = str + 4;
      const t = strchr(msg, ptr, "'");
      if (t < 0) return 21;
      s.success = msg.slice(ptr, t).startsWith('failed') ? S_FAILED : S_SUCCESS;
    } else {
      const r = strstr(msg, mptr, 'result=');
      if (r >= 0) {
        const ptr = r + 7;
        const t = strchr(msg, ptr, ')');
        if (t < 0) return 22;
        s.success = msg.slice(ptr, t).toLowerCase() === 'success' ? S_SUCCESS : S_FAILED;
      }
    }
  }
  return 0;
}

function parseLogin(msg: string, s: SearchItems, env: ParseEnvironment): number {
  const f = env.flags;
  let term = 0;
  if (f.eventPid !== -1) {
    const str = strstr(msg, term, 'pid=');
    if (str < 0) return 1;
    const ptr = str + 4;
    const t = strchr(msg, ptr, ' ');
    if (t < 0) return 2;
    s.pid = toInt32(strtoul(msg.slice(ptr, t)));
    term = t;
  }
  if (f.eventUid !== -1 || f.eventTuid) {
    const str = strstr(msg, term, 'uid=');
    if (str < 0) return 4;
    const ptr = str + 4;
    const t = strchr(msg, ptr, ' ');
    if (t < 0) return 5;
    s.uid = toUint32(strtoul(msg.slice(ptr, t)));
    term = t;
    s.tuid = lookupUid(env, s.uid);
  }
  if (f.eventSubject) {
    const str = strstr(msg, term, 'subj=');
    if (str >= 0) {
      const ptr = str + 5;
      const t = strchr(msg, ptr, ' ');
      if (t < 0) return 12;
      pushAvc(s, { ...newAvcNode(), scontext: msg.slice(str, t) });
      term = t;
    }
  }
  let nullTerm = false;
  if (f.eventLoginuid !== -2 || f.eventTauid) {
    let str = strstr(msg, term, 'new auid=');
    let ptr: number;
    if (str < 0) {
      str = strstr(msg, term, ' auid=');
      if (str < 0) {
        str = strstr(msg, term, 'new loginuid=');
        if (str < 0) return 7;
        ptr = str + 13;
      } else ptr = str + 6;
    } else ptr = str + 9;
    const t = strchr(msg, ptr, ' ');
    s.loginuid = toUint32(strtoul(t < 0 ? msg.slice(ptr) : msg.slice(ptr, t)));
    if (t < 0) nullTerm = true;
    else term = t;
    s.tauid = lookupUid(env, s.loginuid);
  }
  if (f.eventSuccess !== S_UNSET) {
    if (nullTerm) term = 0;
    const str = strstr(msg, term, 'res=');
    if (str >= 0) {
      const ptr = str + 4;
      const t = strchr(msg, ptr, ' ');
      s.success = strtoul(t < 0 ? msg.slice(ptr) : msg.slice(ptr, t));
      if (t >= 0) term = t;
      nullTerm = t < 0;
    } else s.success = S_SUCCESS;
  }
  if (f.eventSessionId !== -2) {
    if (nullTerm) term = 0;
    let str = strstr(msg, term, 'new ses=');
    let ptr: number;
    if (str < 0) {
      str = strstr(msg, term, ' ses=');
      if (str < 0) return 14;
      ptr = str + 5;
    } else ptr = str + 8;
    const t = strchr(msg, ptr, ' ');
    s.sessionId = toUint32(strtoul(t < 0 ? msg.slice(ptr) : msg.slice(ptr, t)));
  }
  return 0;
}

function parseDaemon1(msg: string, s: SearchItems, env: ParseEnvironment): number {
  const f = env.flags;
  let mptr = strchr(msg, 0, ')');
  if (mptr < 0) mptr = 0;
  let term = mptr;
  if (f.eventLoginuid !== -2 || f.eventTauid) {
    const str = strstr(msg, mptr, 'auid=');
    if (str < 0) return 1;
    const ptr = str + 5;
    const t = strchr(msg, ptr, ' ');
    if (t < 0) return 2;
    s.loginuid = toUint32(strtoul(msg.slice(ptr, t)));
    term = t;
    s.tauid = lookupUid(env, s.loginuid);
  }
  if (f.eventPid !== -1) {
    const str = strstr(msg, term, 'pid=');
    if (str < 0) return 4;
    const ptr = str + 4;
    const t = strchr(msg, ptr, ' ');
    if (t < 0) return 5;
    s.pid = toInt32(strtoul(msg.slice(ptr, t)));
    term = t;
  }
  if (f.eventUid !== -1) {
    const ptrKeep = term;
    const str = strstr(msg, term, ' uid=');
    if (str >= 0) {
      const ptr = str + 5;
      const t = strchr(msg, ptr, ' ');
      if (t < 0) return 7;
      s.uid = toUint32(strtoul(msg.slice(ptr, t)));
      term = t;
    } else term = ptrKeep;
  }
  if (f.eventSessionId !== -2) {
    const ptrKeep = term;
    const str = strstr(msg, term, 'ses=');
    if (str >= 0) {
      const ptr = str + 4;
      const t = strchr(msg, ptr, ' ');
      if (t < 0) return 9;
      s.sessionId = toUint32(strtoul(msg.slice(ptr, t)));
      term = t;
    } else term = ptrKeep;
  }
  if (f.eventSubject) {
    const str = strstr(msg, term, 'subj=');
    if (str >= 0) {
      const at = str + 5;
      const t = strchr(msg, at, ' ');
      pushAvc(s, { ...newAvcNode(), scontext: t < 0 ? msg.slice(at) : msg.slice(at, t) });
      if (t >= 0) term = t;
    }
  }
  if (f.eventSuccess !== S_UNSET) {
    const str = strstr(msg, mptr, 'res=');
    if (str >= 0) {
      const ptr = str + 4;
      let t = ptr;
      while (t < msg.length && /[A-Za-z]/.test(msg[t])) t++;
      if (t === ptr) return 12;
      s.success = msg.slice(ptr, t).startsWith('failed') ? S_FAILED : S_SUCCESS;
    }
  }
  return 0;
}

function parseDaemon2(msg: string, s: SearchItems, env: ParseEnvironment): number {
  const f = env.flags;
  let term = 0;
  if (f.eventHostname) {
    const str = strstr(msg, term, 'addr=');
    if (str >= 0) {
      const at = str + 5;
      let t = strchr(msg, at, ':');
      if (t < 0) {
        t = strchr(msg, at, ' ');
        if (t < 0) return 1;
      }
      s.hostname = msg.slice(at, t);
      term = t;
    }
  }
  if (f.eventSuccess !== S_UNSET) {
    const str = strstr(msg, term, 'res=');
    if (str >= 0) {
      const ptr = str + 4;
      let t = ptr;
      while (t < msg.length && /[A-Za-z]/.test(msg[t])) t++;
      if (t === ptr) return 2;
      s.success = msg.slice(ptr, t).startsWith('failed') ? S_FAILED : S_SUCCESS;
    }
  }
  return 0;
}

export function inetNtop6(words: number[]): string {
  let best = { base: -1, len: 0 };
  let current = { base: -1, len: 0 };
  for (let i = 0; i < 8; i++) {
    if (words[i] === 0) {
      if (current.base === -1) current = { base: i, len: 1 };
      else current.len++;
    } else if (current.base !== -1) {
      if (best.base === -1 || current.len > best.len) best = current;
      current = { base: -1, len: 0 };
    }
  }
  if (current.base !== -1 && (best.base === -1 || current.len > best.len)) best = current;
  if (best.base !== -1 && best.len < 2) best = { base: -1, len: 0 };
  let out = '';
  for (let i = 0; i < 8; i++) {
    if (best.base !== -1 && i >= best.base && i < best.base + best.len) {
      if (i === best.base) out += ':';
      continue;
    }
    if (i !== 0) out += ':';
    if (i === 6 && best.base === 0 && (best.len === 6 || (best.len === 7 && words[7] !== 1) || (best.len === 5 && words[5] === 0xffff))) {
      out += `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
      return out;
    }
    out += words[i].toString(16);
  }
  if (best.base !== -1 && best.base + best.len === 8) out += ':';
  return out;
}

function parseSockaddr(msg: string, s: SearchItems, env: ParseEnvironment): number {
  const f = env.flags;
  if (f.eventHostname || f.eventFilename) {
    const str = strstr(msg, 0, 'saddr=');
    if (str >= 0) {
      const at = str + 6;
      const decoded = unescapeHex(msg, at);
      if (decoded === null) return 4;
      const hex = /^[0-9a-fA-F]*/.exec(msg.slice(at))![0];
      const family = parseInt(hex.slice(2, 4) + hex.slice(0, 2), 16);
      if (family === 2) {
        if (hex.length / 2 < 16) return 1;
        if (!f.eventHostname) return 0;
        const octets = [8, 10, 12, 14].map((i) => parseInt(hex.slice(i, i + 2), 16));
        s.hostname = octets.join('.');
      } else if (family === 10) {
        if (hex.length / 2 < 28) return 2;
        if (!f.eventHostname) return 0;
        const words: number[] = [];
        for (let i = 0; i < 8; i++) words.push(parseInt(hex.slice(16 + i * 4, 20 + i * 4), 16));
        s.hostname = inetNtop6(words);
      } else if (family === 1) {
        if (!f.eventFilename) return 0;
        const bytes = hex.slice(4);
        const path = unescapeHex(bytes.length >= 2 ? bytes : '', 0) ?? '';
        const first = path[0];
        const name = first === '\u0000' || path === '' ? path.slice(1) : path;
        if (path.length === 0) return 6;
        s.filename = pushString(s.filename, first ? path : name);
      }
    }
  }
  return 0;
}

function parseIntegrity(msg: string, s: SearchItems, env: ParseEnvironment): number {
  const f = env.flags;
  let term = 0;
  const pidAt = strstr(msg, term, 'pid=');
  if (pidAt >= 0) {
    const ptr = pidAt + 4;
    const t = strchr(msg, ptr, ' ');
    if (t < 0) return 1;
    s.pid = toInt32(strtoul(msg.slice(ptr, t)));
    term = t;
  }
  if (f.eventUid !== -1 || f.eventTuid) {
    const str = strstr(msg, term, ' uid=');
    if (str >= 0) {
      const ptr = str + 4;
      const t = strchr(msg, ptr, ' ');
      if (t < 0) return 3;
      s.uid = toUint32(strtoul(msg.slice(ptr, t)));
      term = t;
      s.tuid = lookupUid(env, s.uid);
    }
  }
  if (f.eventLoginuid !== -2 || f.eventTauid) {
    const str = strstr(msg, 0, 'auid=');
    if (str >= 0) {
      const ptr = str + 5;
      const t = strchr(msg, ptr, ' ');
      if (t < 0) return 5;
      s.loginuid = toUint32(strtoul(msg.slice(ptr, t)));
      term = t;
      s.tauid = lookupUid(env, s.loginuid);
    }
  }
  if (f.eventSessionId !== -2) {
    const str = strstr(msg, term, 'ses=');
    if (str >= 0) {
      const ptr = str + 4;
      const t = strchr(msg, ptr, ' ');
      if (t < 0) return 10;
      s.sessionId = toUint32(strtoul(msg.slice(ptr, t)));
      term = t;
    }
  }
  if (f.eventSubject) {
    const str = strstr(msg, term, 'subj=');
    if (str >= 0) {
      const at = str + 5;
      const t = strchr(msg, at, ' ');
      if (t < 0) return 12;
      pushAvc(s, { ...newAvcNode(), scontext: msg.slice(at, t) });
      term = t;
    }
  }
  if (f.eventComm) {
    const str = strstr(msg, term, 'comm=');
    if (str >= 0) {
      const at = str + 5;
      if (msg[at] === '"') {
        const close = strchr(msg, at + 1, '"');
        if (close < 0) return 7;
        s.comm = msg.slice(at + 1, close);
        term = close;
      } else s.comm = unescapeHex(msg, at);
    }
  }
  if (f.eventFilename) {
    const str = strstr(msg, term, ' name=');
    if (str >= 0 && commonPathParser(s, msg, str + 6)) return 8;
  }
  if (f.eventSuccess !== S_UNSET) {
    const str = strstr(msg, term, 'res=');
    if (str >= 0) {
      const ptr = str + 4;
      const t = strchr(msg, ptr, ' ');
      s.success = strtoul(t < 0 ? msg.slice(ptr) : msg.slice(ptr, t));
    }
  }
  return 0;
}

function parseAvc(msg: string, type: number, s: SearchItems, env: ParseEnvironment): number {
  const f = env.flags;
  let term = 0;
  const an = newAvcNode();
  const marker = strstr(msg, term, 'avc: ');
  let jumpToOther = false;
  if (marker >= 0) {
    const str = marker + 5;
    const brace = strchr(msg, str, '{');
    if (brace < 0) {
      term = 0;
      jumpToOther = true;
    } else {
      term = brace;
      if (f.eventSuccess !== S_UNSET) {
        if (msg.slice(str, term).includes('denied')) {
          s.success = S_FAILED;
          an.avcResult = AVC_DENIED;
        } else {
          s.success = S_SUCCESS;
          an.avcResult = AVC_GRANTED;
        }
      }
      let p = term + 1;
      while (msg[p] === ' ') p++;
      let close = strchr(msg, p, '}');
      if (close < 0) return 2;
      while (msg[close - 1] === ' ') close--;
      an.avcPerm = msg.slice(p, close);
      term = close;
    }
  }
  void jumpToOther;
  if (type === AUDIT.USER_AVC) {
    let rc = parseUser(msg, type, s, env, an);
    if (rc > 20) rc = 0;
    pushAvc(s, an);
    return rc;
  }
  if (f.eventPid !== -1) {
    const str = strstr(msg, term, 'pid=');
    if (str >= 0) {
      const at = str + 4;
      const t = strchr(msg, at, ' ');
      if (t < 0) return 3;
      s.pid = toInt32(strtoul(msg.slice(at, t)));
      term = t;
    }
  }
  if (f.eventComm && s.comm === null) {
    const str = strstr(msg, term, 'comm=');
    if (str < 0) return 5;
    const at = str + 5;
    if (msg[at] === '"') {
      const close = strchr(msg, at + 1, '"');
      if (close < 0) return 6;
      s.comm = msg.slice(at + 1, close);
      term = close;
    } else {
      s.comm = unescapeHex(msg, at);
      if (s.comm === null) return 11;
      term = at + 6;
    }
  }
  if (f.eventFilename) {
    const str = strstr(msg, term, ' path=');
    if (str >= 0) {
      const rc = commonPathParser(s, msg, str + 6);
      if (rc) return rc;
      term += 7;
    } else {
      const nm = strstr(msg, term, ' name=');
      if (nm >= 0) {
        const rc = commonPathParser(s, msg, nm + 6);
        if (rc) return rc;
        term += 7;
      }
    }
  }
  if (f.eventSubject) {
    const str = strstr(msg, term, 'scontext=');
    if (str >= 0) {
      const at = str + 9;
      const t = strchr(msg, at, ' ');
      if (t < 0) return 7;
      an.scontext = msg.slice(at, t);
      term = t;
    }
  }
  if (f.eventObject) {
    const str = strstr(msg, term, 'tcontext=');
    if (str >= 0) {
      const at = str + 9;
      const t = strchr(msg, at, ' ');
      if (t < 0) return 8;
      an.tcontext = msg.slice(at, t);
      term = t;
    }
  }
  const cls = strstr(msg, term, 'tclass=');
  if (cls < 0) return 9;
  const at = cls + 7;
  const t = strchr(msg, at, ' ');
  an.avcClass = t < 0 ? msg.slice(at) : msg.slice(at, t);
  pushAvc(s, an);
  return 0;
}

function parseKernelAnom(msg: string, type: number, s: SearchItems, env: ParseEnvironment): number {
  const f = env.flags;
  let term = 0;
  if (f.eventLoginuid !== -2 || f.eventTauid) {
    const str = strstr(msg, term, 'auid=');
    if (str < 0) return 1;
    const ptr = str + 5;
    const t = strchr(msg, ptr, ' ');
    s.loginuid = toUint32(strtoul(t < 0 ? msg.slice(ptr) : msg.slice(ptr, t)));
    term = t < 0 ? ptr : t;
    s.tauid = lookupUid(env, s.loginuid);
  }
  if (f.eventUid !== -1 || f.eventTuid) {
    const str = strstr(msg, term, 'uid=');
    if (str >= 0) {
      const ptr = str + 4;
      const t = strchr(msg, ptr, ' ');
      if (t < 0) return 3;
      s.uid = toUint32(strtoul(msg.slice(ptr, t)));
      term = t;
      s.tuid = lookupUid(env, s.uid);
    }
  }
  if (f.eventGid !== -1) {
    const str = strstr(msg, term, 'gid=');
    if (str >= 0) {
      const ptr = str + 4;
      const t = strchr(msg, ptr, ' ');
      if (t < 0) return 5;
      s.gid = toUint32(strtoul(msg.slice(ptr, t)));
      term = t;
    }
  }
  if (f.eventSessionId !== -2) {
    const str = strstr(msg, term, 'ses=');
    if (str >= 0) {
      const ptr = str + 4;
      const t = strchr(msg, ptr, ' ');
      s.sessionId = toUint32(strtoul(t < 0 ? msg.slice(ptr) : msg.slice(ptr, t)));
      term = t < 0 ? ptr : t;
    }
  }
  if (type === AUDIT.ANOM_PROMISCUOUS) return 0;
  if (f.eventSubject) {
    const str = strstr(msg, term, 'subj=');
    if (str >= 0) {
      const at = str + 5;
      const t = strchr(msg, at, ' ');
      if (t < 0) return 8;
      pushAvc(s, { ...newAvcNode(), scontext: msg.slice(at, t) });
      term = t;
    }
  }
  if (f.eventPid !== -1) {
    const str = strstr(msg, term, 'pid=');
    if (str >= 0) {
      const ptr = str + 4;
      const t = strchr(msg, ptr, ' ');
      if (t < 0) return 10;
      s.pid = toInt32(strtoul(msg.slice(ptr, t)));
      term = t;
    }
  }
  if (f.eventComm) {
    const str = strstr(msg, term, 'comm=');
    if (str >= 0) {
      const at = str + 5;
      if (msg[at] === '"') {
        const close = strchr(msg, at + 1, '"');
        if (close < 0) return 12;
        s.comm = msg.slice(at + 1, close);
        term = close;
      } else s.comm = unescapeHex(msg, at);
    }
  }
  if (f.eventExe) {
    const str = strstr(msg, term, 'exe=');
    if (str >= 0) {
      const at = str + 4;
      if (msg[at] === '"') {
        const close = strchr(msg, at + 1, '"');
        if (close < 0) return 13;
        s.exe = msg.slice(at + 1, close);
        term = close;
      } else s.exe = unescapeHex(msg, at);
    } else if (type !== AUDIT.ANOM_ABEND) return 14;
  }
  if (type === AUDIT.SECCOMP) {
    const str = strstr(msg, term, 'arch=');
    if (str < 0) return 0;
    let ptr = str + 5;
    let t = strchr(msg, ptr, ' ');
    if (t < 0) return 15;
    s.arch = toInt32(strtoul(msg.slice(ptr, t), 16));
    term = t;
    const sc = strstr(msg, term, 'syscall=');
    if (sc < 0) return 17;
    ptr = sc + 8;
    t = strchr(msg, ptr, ' ');
    if (t < 0) return 18;
    s.syscall = toInt32(strtoul(msg.slice(ptr, t)));
    term = t;
  }
  if (f.eventSuccess !== S_UNSET) {
    const str = strstr(msg, term, 'res=');
    if (str >= 0) {
      const ptr = str + 4;
      const t = strchr(msg, ptr, ' ');
      s.success = strtoul(t < 0 ? msg.slice(ptr) : msg.slice(ptr, t));
    }
  }
  return 0;
}

function parseSimpleMessage(msg: string, type: number, s: SearchItems, env: ParseEnvironment): number {
  const f = env.flags;
  let term = 0;
  if (f.eventLoginuid !== -2 || f.eventTauid) {
    const str = strstr(msg, term, 'auid=');
    if (str < 0 && type !== AUDIT.CONFIG_CHANGE) return 1;
    if (str >= 0) {
      const ptr = str + 5;
      const t = strchr(msg, ptr, ' ');
      s.loginuid = toUint32(strtoul(t < 0 ? msg.slice(ptr) : msg.slice(ptr, t)));
      term = t < 0 ? ptr : t;
      s.tauid = lookupUid(env, s.loginuid);
    }
  }
  if (f.eventSessionId !== -2) {
    const str = strstr(msg, term, 'ses=');
    if (str >= 0) {
      const ptr = str + 4;
      const t = strchr(msg, ptr, ' ');
      s.sessionId = toUint32(strtoul(t < 0 ? msg.slice(ptr) : msg.slice(ptr, t)));
      term = t < 0 ? ptr : t;
    }
  }
  if (f.eventSubject) {
    const str = strstr(msg, term, 'subj=');
    if (str >= 0) {
      const at = str + 5;
      const t = strchr(msg, at, ' ');
      pushAvc(s, { ...newAvcNode(), scontext: t < 0 ? msg.slice(at) : msg.slice(at, t) });
      term = t < 0 ? at : t;
    }
  }
  if (f.eventKey) {
    const str = strstr(msg, term, 'key=');
    if (str >= 0) {
      s.key ??= new StringList();
      const ptr = str + 4;
      if (msg[ptr] === '"') {
        const close = strchr(msg, ptr + 1, '"');
        if (close < 0) return 6;
        s.key = pushString(s.key, msg.slice(ptr + 1, close));
        term = close;
      } else {
        const decoded = unescapeHex(msg, ptr);
        if (decoded === null) return 8;
        for (const part of decoded.split(KEY_SEPARATOR)) if (part !== '') s.key = pushString(s.key, part);
      }
    }
  }
  if (type === AUDIT.CONFIG_CHANGE) s.success = S_SUCCESS;
  if (f.eventSuccess !== S_UNSET) {
    const str = strstr(msg, term, 'res=');
    if (str >= 0) {
      const ptr = str + 4;
      const t = strchr(msg, ptr, ' ');
      s.success = strtoul(t < 0 ? msg.slice(ptr) : msg.slice(ptr, t));
    }
  }
  return 0;
}

function parseTty(msg: string, s: SearchItems, env: ParseEnvironment): number {
  const f = env.flags;
  let term = 0;
  if (f.eventPid !== -1) {
    const str = strstr(msg, 0, 'pid=');
    if (str >= 0) {
      const ptr = str + 4;
      const t = strchr(msg, ptr, ' ');
      if (t < 0) return 1;
      s.pid = toInt32(strtoul(msg.slice(ptr, t)));
      term = t;
    }
  }
  if (f.eventUid !== -1 || f.eventTuid) {
    const str = strstr(msg, term, ' uid=');
    if (str >= 0) {
      const ptr = str + 4;
      const t = strchr(msg, ptr, ' ');
      if (t < 0) return 3;
      s.uid = toUint32(strtoul(msg.slice(ptr, t)));
      term = t;
      s.tuid = lookupUid(env, s.uid);
    }
  }
  if (f.eventLoginuid !== -2 || f.eventTauid) {
    const str = strstr(msg, term, 'auid=');
    if (str < 0) return 5;
    const ptr = str + 5;
    const t = strchr(msg, ptr, ' ');
    s.loginuid = toUint32(strtoul(t < 0 ? msg.slice(ptr) : msg.slice(ptr, t)));
    term = t < 0 ? ptr : t;
    s.tauid = lookupUid(env, s.loginuid);
  }
  if (f.eventSessionId !== -2) {
    const str = strstr(msg, term, 'ses=');
    if (str >= 0) {
      const ptr = str + 4;
      const t = strchr(msg, ptr, ' ');
      if (t < 0) return 7;
      s.sessionId = toUint32(strtoul(msg.slice(ptr, t)));
      term = t;
    }
  }
  if (f.eventComm) {
    const str = strstr(msg, term, 'comm=');
    if (str >= 0) {
      const at = str + 5;
      if (msg[at] === '"') {
        const close = strchr(msg, at + 1, '"');
        if (close < 0) return 11;
        s.comm = msg.slice(at + 1, close);
      } else s.comm = unescapeHex(msg, at);
    }
  }
  return 0;
}

function parsePkt(msg: string, s: SearchItems, env: ParseEnvironment): number {
  const f = env.flags;
  let term = 0;
  if (f.eventHostname) {
    const str = strstr(msg, 0, 'saddr=');
    if (str >= 0) {
      const ptr = str + 6;
      const t = strchr(msg, ptr, ' ');
      if (t < 0) return 1;
      s.hostname = msg.slice(ptr, t);
      term = t;
    }
  }
  if (f.eventObject) {
    const str = strstr(msg, term, 'obj=');
    if (str >= 0) {
      const at = str + 4;
      const t = strchr(msg, at, ' ');
      pushAvc(s, { ...newAvcNode(), tcontext: t < 0 ? msg.slice(at) : msg.slice(at, t) });
    }
  }
  return 0;
}

function parseKernel(msg: string, s: SearchItems, env: ParseEnvironment): number {
  const f = env.flags;
  let term = 0;
  if (f.eventPid !== -1 && s.pid === -1) {
    const str = strstr(msg, term, ' pid=');
    if (str < 0) return 54;
    const ptr = str + 5;
    const t = strchr(msg, ptr, ' ');
    if (t < 0) return 52;
    s.pid = toInt32(strtoul(msg.slice(ptr, t)));
    term = t;
  }
  if (s.uid === UID_UNSET && !s.tuid && (f.eventUid !== -1 || f.eventTuid)) {
    const str = strstr(msg, term, 'uid=');
    if (str >= 0) {
      const ptr = str + 4;
      const t = strchr(msg, ptr, ' ');
      if (t < 0) return 55;
      s.uid = toUint32(strtoul(msg.slice(ptr, t)));
      term = t;
    } else s.uid = 0;
    s.tuid = lookupUid(env, s.uid);
  }
  if (s.loginuid === LOGINUID_UNSET && !s.tauid && (f.eventLoginuid !== -2 || f.eventTauid)) {
    const str = strstr(msg, term, 'auid=');
    if (str >= 0) {
      const ptr = str + 5;
      const t = strchr(msg, ptr, ' ');
      if (t < 0) return 57;
      s.loginuid = toUint32(strtoul(msg.slice(ptr, t)));
      term = t;
    } else s.loginuid = UID_UNSET;
    s.tauid = lookupUid(env, s.loginuid);
  }
  if (!s.terminal && f.eventTerminal) {
    const str = strstr(msg, term, 'tty=');
    if (str >= 0) {
      const at = str + 4;
      const t = strchr(msg, at, ' ');
      if (t < 0) return 59;
      s.terminal = msg.slice(at, t);
      term = t;
    } else s.terminal = '(none)';
  }
  if (s.sessionId === toUint32(-2) && f.eventSessionId !== -2) {
    const str = strstr(msg, term, 'ses=');
    if (str >= 0) {
      const ptr = str + 4;
      const t = strchr(msg, ptr, ' ');
      if (t < 0) return 60;
      s.sessionId = toUint32(strtoul(msg.slice(ptr, t)));
      term = t;
    } else s.sessionId = toUint32(-1);
  }
  if (!s.avc && f.eventSubject) {
    const str = strstr(msg, term, 'subj=');
    if (str < 0) return 64;
    const at = str + 5;
    const t = strchr(msg, at, ' ');
    if (t < 0) return 62;
    pushAvc(s, { ...newAvcNode(), scontext: msg.slice(at, t) });
    term = t;
  }
  if (!s.comm && f.eventComm) {
    const str = strstr(msg, term, 'comm=');
    if (str < 0) return 66;
    const at = str + 5;
    if (msg[at] === '"') {
      const close = strchr(msg, at + 1, '"');
      if (close < 0) return 65;
      s.comm = msg.slice(at + 1, close);
      term = close;
    } else s.comm = unescapeHex(msg, at);
  }
  if (!s.exe && f.eventExe) {
    const str = strstr(msg, 0, 'exe=');
    if (str >= 0) {
      const at = str + 4;
      if (msg[at] === '"') {
        const close = strchr(msg, at + 1, '"');
        if (close < 0) return 67;
        s.exe = msg.slice(at + 1, close);
      } else s.exe = unescapeHex(msg, at);
    } else s.exe = '(null)';
  }
  if (f.eventSuccess !== S_UNSET) {
    const str = strstr(msg, term, 'res=');
    if (str >= 0) {
      const ptr = str + 4;
      const t = strchr(msg, ptr, ' ');
      s.success = strtoul(t < 0 ? msg.slice(ptr) : msg.slice(ptr, t));
    }
  }
  return 0;
}

const NOTHING_TO_PARSE: ReadonlySet<number> = new Set([2000, 1401, 1309, 1311, 1312, 1313, 1314, 1315, 1317, 1321, 1322, 1323, 1327, 1337, 1339]);

export function extractSearchItems(event: AuditEvent, env: ParseEnvironment): number {
  let ret = 0;
  const s = event.s;
  for (const n of event.records) {
    const msg = n.message;
    const type = n.type;
    if (type === AUDIT.SYSCALL || type === AUDIT.URINGOP) ret = parseSyscall(msg, type, s, env, n);
    else if (type === AUDIT.CWD) ret = parseDir(msg, s, env);
    else if (type === AUDIT.AVC_PATH) ret = avcParsePath(msg, s, env);
    else if (type === AUDIT.PATH) ret = parsePath(msg, s, env);
    else if (
      type === AUDIT.USER
      || (type >= AUDIT_RANGES.AUDIT_FIRST_USER_MSG && type <= AUDIT.USER_END)
      || (type >= AUDIT.USER_CHAUTHTOK && type <= AUDIT_RANGES.AUDIT_LAST_USER_MSG)
      || (type >= AUDIT_RANGES.AUDIT_FIRST_USER_MSG2 && type <= AUDIT_RANGES.AUDIT_LAST_USER_MSG2)
    ) ret = parseUser(msg, type, s, env, null);
    else if (type === AUDIT.SOCKADDR) ret = parseSockaddr(msg, s, env);
    else if (type === AUDIT.LOGIN) ret = parseLogin(msg, s, env);
    else if (type === AUDIT.IPC || type === AUDIT.OBJ_PID) ret = parseObj(msg, s, env);
    else if (([AUDIT.DAEMON_START, AUDIT.DAEMON_END, AUDIT.DAEMON_ABORT, AUDIT.DAEMON_CONFIG, AUDIT.DAEMON_ROTATE, AUDIT.DAEMON_RESUME] as readonly number[]).includes(type)) ret = parseDaemon1(msg, s, env);
    else if (type === AUDIT.DAEMON_ACCEPT || type === AUDIT.DAEMON_CLOSE) ret = parseDaemon2(msg, s, env);
    else if (type === AUDIT.CONFIG_CHANGE) {
      ret = parseSimpleMessage(msg, type, s, env);
      avcParsePath(msg, s, env);
    } else if (type === AUDIT.AVC || type === AUDIT.USER_AVC) ret = parseAvc(msg, type, s, env);
    else if (type === AUDIT.NETFILTER_PKT) ret = parsePkt(msg, s, env);
    else if (type === AUDIT.FEATURE_CHANGE || type === AUDIT.ANOM_LINK || type === AUDIT.DM_CTRL) ret = parseTaskInfo(msg, type, s, env);
    else if (type === AUDIT.SECCOMP || type === AUDIT.ANOM_PROMISCUOUS || type === AUDIT.ANOM_ABEND) ret = parseKernelAnom(msg, type, s, env);
    else if (type >= AUDIT.MAC_POLICY_LOAD && type <= AUDIT.MAC_UNLBL_STCDEL) ret = parseSimpleMessage(msg, type, s, env);
    else if (type >= AUDIT.INTEGRITY_DATA && type <= AUDIT.INTEGRITY_RULE) ret = parseIntegrity(msg, s, env);
    else if (type === AUDIT.NETFILTER_CFG || type === AUDIT.EVENT_LISTENER) ret = parseKernel(msg, s, env);
    else if (type === AUDIT.TTY) ret = parseTty(msg, s, env);
    else if (NOTHING_TO_PARSE.has(type) || (type >= 1329 && type <= 1334)) ret = 0;
    else {
      ret = 0;
      env.debug?.(`Unparsed type:${type}\n - skipped`);
    }
    if (ret !== 0) {
      env.debug?.(`Malformed event skipped, rc=${ret}. ${msg}\n`);
      break;
    }
  }
  return ret;
}

