import { AUPARSE_TABLES, FIELD_TYPES } from './AuparseTables';
import { SYSCALL_TABLES } from './AuditSyscallTables';
import { strerror } from './AuditErrnoMessages';
import { errnoToName } from './AuditErrnoTable';
import { AUDIT } from './AuditConstants';
import { bytesToCString, isDigit, isHexDigit, unescapeBytes } from './AuditCString';
import { ttyDataText, type EscapeMode } from './AuditPrint';
import { inetNtop6 } from './AuditSearchParser';
import { strtoulBig } from './AuditCNumbers';

export const MACH = { X86: 0, X86_64: 1, PPC64: 3, PPC: 4, S390X: 5, S390: 6, ARM: 8, AARCH64: 9, PPC64LE: 10, IO_URING: 11 } as const;
const KEY_SEPARATOR = String.fromCharCode(0x01);

const ELF_MACHINES: ReadonlyArray<readonly [number, number]> = [
  [0x40000003, MACH.X86], [0xc000003e, MACH.X86_64], [0x80000015, MACH.PPC64], [0xc0000015, MACH.PPC64LE],
  [0x00000014, MACH.PPC], [0x80000016, MACH.S390X], [0x00000016, MACH.S390], [0x40000028, MACH.ARM],
  [0xc00000b7, MACH.AARCH64],
];

export interface InterpretHost {
  userName(uid: number): string | null;
  groupName(gid: number): string | null;
  protocolName(number: number): string | null;
}

export interface Idata {
  machine: number;
  syscall: number;
  a0: bigint;
  a1: bigint;
  cwd: string | null;
  name: string;
  val: string;
}

const parseCInteger = (text: string, base: number): bigint => strtoulBig(text, base);

const strtoulN = (text: string, base: number): number => Number(parseCInteger(text, base));
const toInt = (value: bigint): number => Number(BigInt.asIntN(32, value));
const toUint = (value: bigint): number => Number(BigInt.asUintN(32, value));

function lookupI2s(table: string, value: number): string | null {
  const rows = AUPARSE_TABLES[table];
  for (const [v, name] of rows) if (v === value) return name;
  return null;
}

function flagNames(table: string, flags: bigint, limit?: number): string[] {
  const rows = limit === undefined ? AUPARSE_TABLES[table] : AUPARSE_TABLES[table].slice(0, limit);
  return rows.filter(([value]) => (BigInt(value) & flags) !== 0n).map(([, name]) => name);
}

function conversionError(val: string): string {
  return `conversion error(${val})`;
}

export function elfToMachine(elf: number): number {
  for (const [value, machine] of ELF_MACHINES) if (value === elf >>> 0) return machine;
  return -1;
}

function machineTable(machine: number): Readonly<Record<number, string>> | null {
  if (machine === MACH.X86) return SYSCALL_TABLES.i386;
  if (machine === MACH.X86_64) return SYSCALL_TABLES.x86_64;
  if (machine === MACH.AARCH64) return SYSCALL_TABLES.aarch64;
  return null;
}

export function syscallToName(syscall: number, machine: number): string | null {
  return machineTable(machine)?.[syscall] ?? null;
}

const FIELD_TYPE_MAP: ReadonlyMap<string, string> = new Map(FIELD_TYPES);

export function lookupType(name: string): string {
  return FIELD_TYPE_MAP.get(name) ?? 'UNCLASSIFIED';
}

function isIntString(text: string): boolean {
  return /^[0-9]*$/.test(text);
}

function isHexString(text: string): boolean {
  return /^[0-9a-fA-F]*$/.test(text);
}

export function adjustType(rtype: number, name: string, val: string): string {
  if (rtype === 1309 && name[0] === 'a' && name !== 'argc' && !name.includes('_len')) return 'ESCAPED';
  if (rtype === AUDIT.AVC && name === 'saddr') return 'UNCLASSIFIED';
  if (rtype === 1124 && name === 'msg') return 'ESCAPED';
  if (rtype === AUDIT.NETFILTER_PKT && name === 'saddr') return 'ADDR';
  if (name === 'acct') {
    if (val[0] === '"') return 'ESCAPED';
    if (isHexString(val)) return 'ESCAPED';
    return 'UNCLASSIFIED';
  }
  if (rtype === AUDIT.PATH && name[0] === 'f' && name === 'flags') return 'FLAGS';
  if (rtype === 1312 && name === 'mode') return 'MODE_SHORT';
  if (rtype === 2404 && name === 'fp') return 'UNCLASSIFIED';
  if (name === 'id' && (rtype === AUDIT.ADD_GROUP || rtype === 1132 || rtype === AUDIT.DEL_GROUP)) return 'GID';
  if (rtype === 1121) {
    if (val[0] === '"') return 'ESCAPED';
    if (isIntString(val)) return 'UNCLASSIFIED';
    if (isHexString(val)) return 'ESCAPED';
    return 'UNCLASSIFIED';
  }
  if (rtype === 1330 && name === 'name') return 'ESCAPED';
  return lookupType(name);
}

function pathNorm(name: string): string | null {
  if (name === '') return null;
  if (name[0] === '.') return name;
  const parts: string[] = [];
  for (const component of name.split('/')) {
    if (component === '' || component === '.') continue;
    if (component === '..') {
      parts.pop();
      continue;
    }
    parts.push(component);
  }
  return `/${parts.join('/')}`;
}

function unescapedBytes(val: string): number[] | null {
  return unescapeBytes(val, 0);
}

function printEscapedBytes(val: string | null): number[] {
  const encoder = new TextEncoder();
  if (val === null) return [0x20];
  if (val[0] === '"') {
    const inner = val.slice(1);
    const term = inner.indexOf('"');
    if (term < 0) return [0x20];
    return [...encoder.encode(inner.slice(0, term))];
  }
  const out = val[0] === '0' && val[1] === '0' ? unescapedBytes(val.slice(2)) : unescapedBytes(val);
  if (out) return out;
  return [...encoder.encode(val)];
}

function printEscaped(val: string | null): string {
  return bytesToCString(printEscapedBytes(val));
}

function printEscapedExt(id: Idata): string {
  if (id.cwd === null) return printEscaped(id.val);
  let str2 = printEscaped(id.val);
  let str3: string;
  if (str2[0] !== '/') str3 = `${printEscaped(id.cwd)}/${str2}`;
  else str3 = str2;
  if (!str3.includes('..')) return str3;
  str2 = pathNorm(str3) ?? str3;
  return str2;
}

function printProctitle(val: string): string {
  const bytes = printEscapedBytes(val);
  if (val[0] !== '"') {
    const end = Math.floor(val.length / 2);
    for (let i = 0; i < end && i < bytes.length; i++) if (bytes[i] === 0) bytes[i] = 0x20;
  }
  return bytesToCString(bytes);
}

const SH_SET = '"\'`$\\!()| ';
const QUOTE_SET = '"\'`$\\!()| ;#&*?[]<>{}';

function octal(code: number): string {
  return `\\${(code & 0o300) >> 6}${(code & 0o070) >> 3}${code & 0o007}`;
}

function escapeText(text: string, mode: EscapeMode): string {
  if (mode === 'raw') return text;
  let out = '';
  for (const byte of new TextEncoder().encode(text)) {
    const ch = String.fromCharCode(byte);
    if (byte < 32) out += octal(byte);
    else if (mode === 'shell' && SH_SET.includes(ch)) out += `\\${ch}`;
    else if (mode === 'shell_quote' && QUOTE_SET.includes(ch)) out += `\\${ch}`;
    else out += byte < 128 ? ch : '\u0000';
  }
  if (!/[\u0000]/.test(out)) return out;
  let rebuilt = '';
  const chunk: number[] = [];
  const flush = (): void => {
    if (chunk.length) { rebuilt += new TextDecoder().decode(Uint8Array.from(chunk)); chunk.length = 0; }
  };
  for (const byte of new TextEncoder().encode(text)) {
    if (byte >= 128) { chunk.push(byte); continue; }
    flush();
    const ch = String.fromCharCode(byte);
    if (byte < 32) rebuilt += octal(byte);
    else if (mode === 'shell' && SH_SET.includes(ch)) rebuilt += `\\${ch}`;
    else if (mode === 'shell_quote' && QUOTE_SET.includes(ch)) rebuilt += `\\${ch}`;
    else rebuilt += ch;
  }
  flush();
  return rebuilt;
}

function needsEscaping(text: string, mode: EscapeMode): boolean {
  if (mode === 'raw') return false;
  for (const byte of new TextEncoder().encode(text)) {
    const ch = String.fromCharCode(byte);
    if (byte < 32) return true;
    if (mode === 'shell' && SH_SET.includes(ch)) return true;
    if (mode === 'shell_quote' && QUOTE_SET.includes(ch)) return true;
  }
  return false;
}

export class Interpreter {
  private lastFanType = 2;

  constructor(private readonly host: InterpretHost) {}

  private lookupUid(uid: number): string {
    if ((uid >>> 0) === 0xffffffff) return 'unset';
    if (uid === 0) return 'root';
    return this.host.userName(uid) ?? `unknown(${uid | 0})`;
  }

  private lookupGid(gid: number): string {
    if ((gid >>> 0) === 0xffffffff) return 'unset';
    if (gid === 0) return 'root';
    return this.host.groupName(gid) ?? `unknown(${gid | 0})`;
  }

  private printUid(val: string, base: number): string {
    return this.lookupUid(toUint(parseCInteger(val, base)));
  }

  private printGid(val: string, base: number): string {
    return this.lookupGid(toUint(parseCInteger(val, base)));
  }

  private printArch(val: string, machineIn: number): string {
    let machine = machineIn;
    if (machine < 0 || machine > MACH.AARCH64) machine = elfToMachine(strtoulN(val, 16));
    if (machine < 0) return `unknown-elf-type(${val})`;
    const name = lookupI2s('machine', machine);
    return name ?? `unknown-machine-type(${machine})`;
  }

  private printIpcCall(val: string, base: number): string {
    const a0 = toInt(parseCInteger(val, base));
    return lookupI2s('ipc', a0) ?? `unknown-ipccall(${val})`;
  }

  private printSocketCall(val: string, base: number): string {
    const a0 = toInt(parseCInteger(val, base));
    return lookupI2s('sock', a0) ?? `unknown-socketcall(${val})`;
  }

  private printSyscall(id: Idata): string {
    const machine = id.machine < 0 ? MACH.X86_64 : id.machine;
    const sys = syscallToName(id.syscall, machine);
    if (sys === null) return `unknown-syscall(${id.syscall})`;
    let func: string | null = null;
    if (sys === 'socketcall') {
      if (BigInt(toInt(id.a0)) === id.a0) func = lookupI2s('sock', toInt(id.a0));
    } else if (sys === 'ipc') {
      if (BigInt(toInt(id.a0)) === id.a0) func = lookupI2s('ipc', toInt(id.a0));
    }
    return func ? `${sys}(${func})` : sys;
  }

  private printExit(val: string): string {
    const ival = BigInt.asIntN(64, parseCInteger(val, 10));
    if (ival < 0n) {
      const code = Number(-ival);
      return `${errnoToName(code) ?? '(null)'}(${strerror(code)})`;
    }
    return val;
  }

  private printPerm(val: string): string {
    let ival = toInt(parseCInteger(val, 10));
    if (ival === 0) ival = 0x0f;
    const parts: string[] = [];
    if (ival & 4) parts.push('read');
    if (ival & 2) parts.push('write');
    if (ival & 1) parts.push('exec');
    if (ival & 8) parts.push('attr');
    return parts.join(',');
  }

  private printMode(val: string, base: number): string {
    const ival = toUint(parseCInteger(val, base));
    let buf = lookupI2s('ftype', ival & 0o170000) ?? (((ival & 0o170000) / 0o10000) >>> 0).toString(8).padStart(3, '0');
    if (ival & 0o4000) buf += ',suid';
    if (ival & 0o2000) buf += ',sgid';
    if (ival & 0o1000) buf += ',sticky';
    return `${buf},${(ival & 0o777).toString(8).padStart(3, '0')}`;
  }

  private printModeShortInt(ival: number): string {
    const parts: string[] = [];
    if (ival & 0o4000) parts.push('suid');
    if (ival & 0o2000) parts.push('sgid');
    if (ival & 0o1000) parts.push('sticky');
    const perms = `0${(ival & 0o777).toString(8).padStart(3, '0')}`;
    return parts.length ? `${parts.join(',')},${perms}` : perms;
  }

  private printModeShort(val: string, base: number): string {
    return this.printModeShortInt(toUint(parseCInteger(val, base)));
  }

  private printSocketDomain(val: string): string {
    const i = toInt(parseCInteger(val, 16));
    return lookupI2s('fam', i) ?? `unknown-family(0x${val})`;
  }

  private printSocketType(val: string): string {
    const type = 0xff & strtoulN(val, 16);
    return lookupI2s('sock_type', type) ?? `unknown-type(${val})`;
  }

  private printSocketProto(val: string): string {
    const proto = toUint(parseCInteger(val, 16));
    return this.host.protocolName(proto) ?? `unknown-proto(${val})`;
  }

  private printSockaddr(val: string): string {
    const bytes = unescapeBytes(val, 0);
    if (bytes === null) return `malformed-host(${val})`;
    const slen = Math.floor(val.length / 2);
    const family = (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8);
    const str = lookupI2s('fam', family);
    if (str === null) return `unknown-family(${family})`;
    const at = (i: number): number => bytes[i] ?? 0;
    switch (family) {
      case 1: {
        if (slen < 4) return `{ saddr_fam=${str} ${slen === 2 ? 'unnamed socket' : 'sockaddr len too short'} }`;
        const path = bytes.slice(2, 110);
        if (path[0] !== 0) return `{ saddr_fam=${str} path=${bytesToCString(path)} }`;
        return `{ saddr_fam=${str} path=${bytesToCString(path.slice(1))} }`;
      }
      case 2: {
        if (slen < 16) return `{ saddr_fam=${str} sockaddr len too short }`;
        return `{ saddr_fam=${str} laddr=${at(4)}.${at(5)}.${at(6)}.${at(7)} lport=${(at(2) << 8) | at(3)} }`;
      }
      case 3: {
        const call = bytes.slice(2, 9).map((b) => String.fromCharCode(b)).join('');
        return `{ saddr_fam=${str} call=${call} }`.split('\u0000')[0];
      }
      case 4:
        return `{ saddr_fam=${str} lport=${(at(2) << 8) | at(3)} ipx-net=${((at(4) << 24) | (at(5) << 16) | (at(6) << 8) | at(7)) >>> 0} }`;
      case 8:
        return `{ saddr_fam=${str} int=${(at(4) | (at(5) << 8) | (at(6) << 16) | (at(7) << 24)) | 0} }`;
      case 9: {
        const addr = bytesToCString(bytes.slice(2, 17));
        return `{ saddr_fam=${str} laddr=${addr} }`;
      }
      case 10: {
        if (slen < 28) return `{ saddr_fam=${str} sockaddr6 len too short }`;
        const groups: number[] = [];
        for (let i = 0; i < 8; i++) groups.push((at(8 + 2 * i) << 8) | at(9 + 2 * i));
        return `{ saddr_fam=${str} laddr=${inetNtop6(groups)} lport=${(at(2) << 8) | at(3)} }`;
      }
      case 16: {
        if (slen < 12) return `{ saddr_fam=${str} len too short }`;
        const nlFamily = at(0) | (at(1) << 8);
        const pid = (at(4) | (at(5) << 8) | (at(6) << 16) | (at(7) << 24)) >>> 0;
        return `{ saddr_fam=${str} nlnk-fam=${nlFamily} nlnk-pid=${pid} }`;
      }
      default:
        return `{ saddr_fam=${str} (unsupported) }`;
    }
  }

  private printFlags(val: string): string {
    const flags = toInt(parseCInteger(val, 16));
    if (flags === 0) return 'none';
    const names = AUPARSE_TABLES.flag.filter(([value]) => (value & flags) !== 0).map(([, name]) => name);
    return names.length ? names.join(',') : `0x${val}`;
  }

  private printCapabilities(val: string, base: number): string {
    const cap = toInt(parseCInteger(val, base));
    return lookupI2s('cap', cap) ?? `unknown-capability(${base === 16 ? '0x' : ''}${val})`;
  }

  private printCapBitmap(val: string): string {
    const temp = parseCInteger(val, 16);
    const caps = [Number(temp & 0xffffffffn), Number((temp & 0xffffffff00000000n) >> 32n)];
    const names: string[] = [];
    for (let i = 0; i <= 40; i++) {
      if ((caps[Math.floor(i / 32)] >>> (i % 32)) & 1) {
        names.push(lookupI2s('cap', i) ?? '');
      }
    }
    return names.length ? names.join(',') : 'none';
  }

  private printSuccess(val: string): string {
    if (isDigit(val[0])) {
      const res = toInt(parseCInteger(val, 10));
      if (res === 0) return 'no';
      if (res === 1) return 'yes';
      return 'unset';
    }
    return val;
  }

  private printOpenFlags(val: string, base: number): string {
    const flags = parseCInteger(val, base);
    const names: string[] = [];
    if ((flags & 3n) === 0n) names.push('O_RDONLY');
    names.push(...flagNames('open_flag', flags));
    return names.length ? names.join('|') : `0x${val}`;
  }

  private printCloneFlags(val: string): string {
    const flags = toUint(parseCInteger(val, 16));
    const names = flagNames('clone_flag', BigInt(flags));
    const cloneSig = flags & 0xff;
    if (cloneSig && cloneSig < 32) {
      const s = lookupI2s('signal', cloneSig);
      if (s !== null) names.push(s);
    }
    return names.length ? names.join('|') : `0x${flags.toString(16)}`;
  }

  private printFcntlCmd(val: string): string {
    const cmd = toInt(parseCInteger(val, 16));
    return lookupI2s('fcntl', cmd) ?? `unknown-fcntl-command(${cmd})`;
  }

  private printEpollCtl(val: string): string {
    const cmd = toInt(parseCInteger(val, 16));
    return lookupI2s('epoll_ctl', cmd) ?? `unknown-epoll_ctl-operation(${cmd})`;
  }

  private printClockId(val: string): string {
    const i = toInt(parseCInteger(val, 16));
    if (i < 7) {
      const s = lookupI2s('clock', i);
      if (s !== null) return s;
    }
    return `unknown-clk_id(0x${val})`;
  }

  private printProt(val: string, isMmap: boolean): string {
    const prot = toUint(parseCInteger(val, 16));
    if ((prot & 0x07) === 0) return 'PROT_NONE';
    const names = flagNames('prot', BigInt(prot), isMmap ? 4 : 3);
    return names.length ? names.join('|') : `0x${val}`;
  }

  private printMmap(val: string): string {
    const maps = toUint(parseCInteger(val, 16));
    const names: string[] = [];
    if ((maps & 0x0f) === 0) names.push('MAP_FILE');
    names.push(...flagNames('mmap', BigInt(maps)));
    return names.length ? names.join('|') : `0x${val}`;
  }

  private printPersonality(val: string): string {
    const pers = toInt(parseCInteger(val, 16));
    const s = lookupI2s('person', pers & 0xff);
    if (s !== null) return pers & 0x0040000 ? `${s}|~ADDR_NO_RANDOMIZE` : s;
    return `unknown-personality(0x${val})`;
  }

  private printPtrace(val: string): string {
    return lookupI2s('ptrace', toInt(parseCInteger(val, 16))) ?? `unknown-ptrace(0x${val})`;
  }

  private printPrctlOpt(val: string): string {
    return lookupI2s('prctl_opt', toInt(parseCInteger(val, 16))) ?? `unknown-prctl-option(0x${val})`;
  }

  private printFlagTable(table: string, val: string): string {
    const names = flagNames(table, BigInt(toUint(parseCInteger(val, 16))));
    return names.length ? names.join('|') : `0x${val}`;
  }

  private printRlimit(val: string): string {
    const i = toInt(parseCInteger(val, 16));
    if (i < 17) {
      const s = lookupI2s('rlimit', i);
      if (s !== null) return s;
    }
    return `unknown-rlimit(0x${val})`;
  }

  private printAccess(val: string): string {
    const mode = parseCInteger(val, 16);
    if ((mode & 0xfn) === 0n) return 'F_OK';
    const names = flagNames('access', mode, 3);
    return names.length ? names.join('|') : `0x${val}`;
  }

  private printDirfd(val: string): string {
    return toUint(parseCInteger(val, 16)) === 0xffffff9c ? 'AT_FDCWD' : `0x${val}`;
  }

  private printSched(val: string): string {
    const pol = toUint(parseCInteger(val, 16));
    const s = lookupI2s('sched', pol & 0x0f);
    if (s !== null) return pol & 0x40000000 ? `${s}|SCHED_RESET_ON_FORK` : s;
    return `unknown-scheduler-policy(0x${val})`;
  }

  private printSockOptLevel(val: string): string {
    const lvl = toInt(parseCInteger(val, 16));
    if (lvl === 1) return 'SOL_SOCKET';
    const p = this.host.protocolName(lvl);
    if (p !== null) return p;
    return lookupI2s('socklevel', lvl) ?? `unknown-sockopt-level(0x${val})`;
  }

  private printSockOptName(val: string, machine: number): string {
    let opt = toInt(parseCInteger(val, 16));
    if ((machine === MACH.PPC64 || machine === MACH.PPC) && opt >= 16 && opt <= 21) opt += 100;
    return lookupI2s('sockoptname', opt) ?? `unknown-sockopt-name(0x${val})`;
  }

  private printNamed(table: string, val: string, unknown: string): string {
    return lookupI2s(table, toInt(parseCInteger(val, 16))) ?? `${unknown}(0x${val})`;
  }

  private printUdpOptName(val: string): string {
    const opt = toInt(parseCInteger(val, 16));
    if (opt === 1) return 'UDP_CORK';
    if (opt === 100) return 'UDP_ENCAP';
    return `unknown-udpopt-name(0x${val})`;
  }

  private printShmFlags(val: string): string {
    const flags = toUint(parseCInteger(val, 16));
    const names = [...flagNames('ipccmd', BigInt(flags & 0o3000)), ...flagNames('shm_mode', BigInt(flags & 0o14000))];
    let buf = names.join('|');
    const tmode = this.printModeShortInt(flags & 0o777);
    buf = buf ? `${buf}|${tmode}` : tmode;
    return buf;
  }

  private printSeek(val: string): string {
    const whence = 0xff & strtoulN(val, 16);
    return lookupI2s('seek', whence) ?? `unknown-whence(${val})`;
  }

  private printIoctlReq(val: string): string {
    const req = toInt(parseCInteger(val, 16));
    return lookupI2s('ioctlreq', req) ?? `0x${(req >>> 0).toString(16)}`;
  }

  private printFanotify(val: string): string {
    if (isDigit(val[0])) {
      const res = toUint(parseCInteger(val, 10));
      if (res === 1) return 'allow';
      if (res === 2) return 'deny';
      return 'unknown';
    }
    return val;
  }

  private printBpf(val: string): string {
    return lookupI2s('bpf', toUint(parseCInteger(val, 16))) ?? `unknown-bpf-cmd(${val})`;
  }

  private printOpenat2Resolve(val: string): string {
    const names = flagNames('openat2_resolve', parseCInteger(val, 16));
    return names.length ? names.join('|') : `0x${val}`;
  }

  private printFanType(val: string): string {
    if (val === '0') { this.lastFanType = 0; return 'none'; }
    if (val === '1') { this.lastFanType = 1; return 'rule_info'; }
    this.lastFanType = 2;
    return 'unknown';
  }

  private printFanInfo(val: string): string {
    if (this.lastFanType === 1) return parseCInteger(val, 16).toString();
    return val;
  }

  private printErrno(val: string): string {
    return errnoToName(toInt(parseCInteger(val, 10))) ?? 'UNKNOWN';
  }

  private printSignals(val: string, base: number): string {
    const i = toInt(parseCInteger(val, base));
    if (i < 32) {
      const s = lookupI2s('signal', i);
      if (s !== null) return s;
    }
    return `unknown-signal(${base === 16 ? '0x' : ''}${val})`;
  }

  private printA0(val: string, id: Idata): string {
    const sys = syscallToName(id.syscall, id.machine);
    if (sys !== null) {
      const c = sys[0];
      if (c === 'r') {
        if (sys === 'rt_sigaction') return this.printSignals(val, 16);
        if (sys.startsWith('renameat')) return this.printDirfd(val);
        if (sys === 'readlinkat') return this.printDirfd(val);
      } else if (c === 'c') {
        if (sys === 'clock_settime') return this.printClockId(val);
      } else if (c === 'p') {
        if (sys === 'personality') return this.printPersonality(val);
        if (sys === 'ptrace') return this.printPtrace(val);
        if (sys === 'prctl') return this.printPrctlOpt(val);
      } else if (c === 'm') {
        if (sys === 'mkdirat') return this.printDirfd(val);
        if (sys === 'mknodat') return this.printDirfd(val);
      } else if (c === 'f') {
        if (sys === 'fchownat') return this.printDirfd(val);
        if (sys === 'futimesat') return this.printDirfd(val);
        if (sys === 'fchmodat') return this.printDirfd(val);
        if (sys.startsWith('faccessat')) return this.printDirfd(val);
        if (sys === 'futimensat') return this.printDirfd(val);
      } else if (c === 'u') {
        if (sys === 'unshare') return this.printCloneFlags(val);
        if (sys === 'unlinkat') return this.printDirfd(val);
        if (sys === 'utimensat') return this.printDirfd(val);
      } else if (sys.slice(1) === 'etrlimit') return this.printRlimit(val);
      else if (c === 's') {
        if (sys === 'setuid') return this.printUid(val, 16);
        if (sys === 'setreuid') return this.printUid(val, 16);
        if (sys === 'setresuid') return this.printUid(val, 16);
        if (sys === 'setfsuid') return this.printUid(val, 16);
        if (sys === 'setgid') return this.printGid(val, 16);
        if (sys === 'setregid') return this.printGid(val, 16);
        if (sys === 'setresgid') return this.printGid(val, 16);
        if (sys === 'socket') return this.printSocketDomain(val);
        if (sys === 'setfsgid') return this.printGid(val, 16);
        if (sys === 'socketcall') return this.printSocketCall(val, 16);
      } else if (sys === 'linkat') return this.printDirfd(val);
      else if (sys === 'newfstatat') return this.printDirfd(val);
      else if (sys.startsWith('openat')) return this.printDirfd(val);
      else if (sys === 'name_to_handle_at') return this.printDirfd(val);
      else if (sys === 'ipccall') return this.printIpcCall(val, 16);
      else if (sys.startsWith('exit')) return val === '0' ? 'EXIT_SUCCESS' : val === '1' ? 'EXIT_FAILURE' : 'UNKNOWN';
      else if (sys === 'bpf') return this.printBpf(val);
    }
    return `0x${val}`;
  }

  private printA1(val: string, id: Idata): string {
    const sys = syscallToName(id.syscall, id.machine);
    if (sys !== null) {
      const c = sys[0];
      if (c === 'f') {
        if (sys === 'fchmod') return this.printModeShort(val, 16);
        if (sys.startsWith('fcntl')) return this.printFcntlCmd(val);
      } else if (c === 'c') {
        if (sys === 'chmod') return this.printModeShort(val, 16);
        if (sys.includes('chown')) return this.printUid(val, 16);
        if (sys === 'creat') return this.printModeShort(val, 16);
      }
      if (sys.slice(1) === 'etsockopt') return this.printSockOptLevel(val);
      else if (c === 's') {
        if (sys === 'setreuid') return this.printUid(val, 16);
        if (sys === 'setresuid') return this.printUid(val, 16);
        if (sys === 'setregid') return this.printGid(val, 16);
        if (sys === 'setresgid') return this.printGid(val, 16);
        if (sys === 'socket') return this.printSocketType(val);
        if (sys === 'setns') return this.printCloneFlags(val);
        if (sys === 'sched_setscheduler') return this.printSched(val);
      } else if (c === 'm') {
        if (sys === 'mkdir') return this.printModeShort(val, 16);
        if (sys === 'mknod') return this.printMode(val, 16);
        if (sys === 'mq_open') return this.printOpenFlags(val, 16);
      } else if (sys === 'open') return this.printOpenFlags(val, 16);
      else if (sys === 'access') return this.printAccess(val);
      else if (sys === 'epoll_ctl') return this.printEpollCtl(val);
      else if (sys === 'kill') return this.printSignals(val, 16);
      else if (sys === 'prctl') {
        if (id.a0 === 23n || id.a0 === 24n) return this.printCapabilities(val, 16);
        if (id.a0 === 1n) return this.printSignals(val, 16);
      } else if (sys === 'tkill') return this.printSignals(val, 16);
      else if (sys === 'umount2') return this.printFlagTable('umount', val);
      else if (sys === 'ioctl') return this.printIoctlReq(val);
    }
    return `0x${val}`;
  }

  private printA2(val: string, id: Idata): string {
    const sys = syscallToName(id.syscall, id.machine);
    if (sys !== null) {
      const c = sys[0];
      if (sys.startsWith('fcntl')) {
        const ival = toInt(parseCInteger(val, 16));
        if (id.a1 === 8n) return this.printUid(val, 16);
        if (id.a1 === 2n && ival === 1) return 'FD_CLOEXEC';
      } else if (sys.slice(1) === 'etsockopt') {
        if (id.a1 === 0n) return this.printNamed('ipoptname', val, 'unknown-ipopt-name');
        if (id.a1 === 1n) return this.printSockOptName(val, id.machine);
        if (id.a1 === 6n) return this.printNamed('tcpoptname', val, 'unknown-tcpopt-name');
        if (id.a1 === 17n) return this.printUdpOptName(val);
        if (id.a1 === 41n) return this.printNamed('ip6optname', val, 'unknown-ip6opt-name');
        if (id.a1 === 263n) return this.printNamed('pktoptname', val, 'unknown-pktopt-name');
        return `0x${val}`;
      } else if (c === 'o') {
        if (sys === 'openat') return this.printOpenFlags(val, 16);
        if (sys === 'open' && (id.a1 & 0o100n)) return this.printModeShort(val, 16);
        if (sys === 'open_by_handle_at') return this.printOpenFlags(val, 16);
      } else if (c === 'f') {
        if (sys === 'fchmodat') return this.printModeShort(val, 16);
        if (sys.startsWith('faccessat')) return this.printAccess(val);
      } else if (c === 's') {
        if (sys === 'setresuid') return this.printUid(val, 16);
        if (sys === 'setresgid') return this.printGid(val, 16);
        if (sys === 'socket') return this.printSocketProto(val);
        if (sys === 'sendmsg') return this.printFlagTable('recv', val);
        if (sys === 'shmget') return this.printShmFlags(val);
      } else if (c === 'm') {
        if (sys === 'mmap') return this.printProt(val, true);
        if (sys === 'mkdirat') return this.printModeShort(val, 16);
        if (sys === 'mknodat') return this.printModeShort(val, 16);
        if (sys === 'mprotect') return this.printProt(val, false);
        if (sys === 'mq_open' && (id.a1 & 0o100n)) return this.printModeShort(val, 16);
      } else if (c === 'r') {
        if (sys === 'recvmsg') return this.printFlagTable('recv', val);
        if (sys === 'readlinkat') return this.printDirfd(val);
        if (sys.startsWith('renameat')) return this.printDirfd(val);
      } else if (c === 'l') {
        if (sys === 'linkat') return this.printDirfd(val);
        if (sys === 'lseek') return this.printSeek(val);
      } else if (c === 'c') {
        if (sys === 'clone') return this.printCloneFlags(val);
        if (sys === 'clone2') return this.printCloneFlags(val);
      } else if (sys.includes('chown')) return this.printGid(val, 16);
      else if (sys === 'tgkill') return this.printSignals(val, 16);
    }
    return `0x${val}`;
  }

  private printA3(val: string, id: Idata): string {
    const sys = syscallToName(id.syscall, id.machine);
    if (sys !== null) {
      const c = sys[0];
      if (c === 'm') {
        if (sys === 'mmap') return this.printMmap(val);
        if (sys === 'mount') return this.printFlagTable('mount', val);
      } else if (c === 'r') {
        if (sys === 'recv' || sys === 'recvfrom' || sys === 'recvmmsg') return this.printFlagTable('recv', val);
      } else if (c === 's') {
        if (sys === 'send' || sys === 'sendto' || sys === 'sendmmsg') return this.printFlagTable('recv', val);
      }
    }
    return `0x${val}`;
  }

  private printSeccompCode(val: string): string {
    const code = parseCInteger(val, 16);
    const s = lookupI2s('seccomp', Number(code & 0x7fff0000n));
    return s ?? `unknown-seccomp-code(${val})`;
  }

  private printTtyData(val: string): string | null {
    if (!isHexString(val)) return val;
    return ttyDataText(val);
  }

  doInterpretation(type: string, id: Idata, mode: EscapeMode): string | null {
    let out: string | null;
    switch (type) {
      case 'UID': out = this.printUid(id.val, 10); break;
      case 'GID': out = this.printGid(id.val, 10); break;
      case 'SYSCALL': out = this.printSyscall(id); break;
      case 'ARCH': out = this.printArch(id.val, id.machine); break;
      case 'EXIT': out = this.printExit(id.val); break;
      case 'ESCAPED':
      case 'ESCAPED_FILE': out = printEscapedExt(id); break;
      case 'ESCAPED_KEY': out = printEscaped(id.val); break;
      case 'PERM': out = this.printPerm(id.val); break;
      case 'MODE': out = this.printMode(id.val, 8); break;
      case 'MODE_SHORT': out = this.printModeShort(id.val, 8); break;
      case 'SOCKADDR': out = this.printSockaddr(id.val); break;
      case 'FLAGS': out = this.printFlags(id.val); break;
      case 'PROMISC': out = toInt(parseCInteger(id.val, 10)) === 0 ? 'no' : 'yes'; break;
      case 'CAPABILITY': out = this.printCapabilities(id.val, 10); break;
      case 'SUCCESS': out = this.printSuccess(id.val); break;
      case 'A0': out = this.printA0(id.val, id); break;
      case 'A1': out = this.printA1(id.val, id); break;
      case 'A2': out = this.printA2(id.val, id); break;
      case 'A3': out = this.printA3(id.val, id); break;
      case 'SIGNAL': out = this.printSignals(id.val, 10); break;
      case 'LIST': out = lookupI2s('filter_list', toInt(parseCInteger(id.val, 10))) ?? `unknown-list(${id.val})`; break;
      case 'TTY_DATA': out = this.printTtyData(id.val); break;
      case 'SESSION': out = id.val === '4294967295' ? 'unset' : id.val; break;
      case 'CAP_BITMAP': out = this.printCapBitmap(id.val); break;
      case 'NFPROTO': out = lookupI2s('nfproto', toInt(parseCInteger(id.val, 10))) ?? `unknown-netfilter-protocol(${id.val})`; break;
      case 'ICMPTYPE': out = lookupI2s('icmptype', toInt(parseCInteger(id.val, 10))) ?? `unknown-icmp-type(${id.val})`; break;
      case 'PROTOCOL': out = this.host.protocolName(toInt(parseCInteger(id.val, 10))) ?? 'undefined protocol'; break;
      case 'ADDR': out = id.val; break;
      case 'PERSONALITY': out = this.printPersonality(id.val); break;
      case 'SECCOMP': out = this.printSeccompCode(id.val); break;
      case 'OFLAG': out = this.printOpenFlags(id.val, 0); break;
      case 'MMAP': out = this.printMmap(id.val); break;
      case 'PROCTITLE': out = printProctitle(id.val); break;
      case 'HOOK': out = lookupI2s('inethook', toInt(parseCInteger(id.val, 16))) ?? `unknown-hook(${id.val})`; break;
      case 'NETACTION': out = lookupI2s('netaction', toInt(parseCInteger(id.val, 16))) ?? `unknown-action(${id.val})`; break;
      case 'MACPROTO': {
        const t = toInt(parseCInteger(id.val, 16));
        out = t === 0x0800 ? 'IP' : t === 0x0806 ? 'ARP' : 'UNKNOWN';
        break;
      }
      case 'IOCTL_REQ': out = this.printIoctlReq(id.val); break;
      case 'FANOTIFY': out = this.printFanotify(id.val); break;
      case 'NLMCGRP': out = strtoulN(id.val, 16) === 1 ? 'audit-netlink-multicast' : 'audit-none'; break;
      case 'RESOLVE': out = this.printOpenat2Resolve(id.val); break;
      case 'TRUST': out = id.val === '0' ? 'no' : id.val === '1' ? 'yes' : 'unknown'; break;
      case 'FAN_TYPE': out = this.printFanType(id.val); break;
      case 'FAN_INFO': out = this.printFanInfo(id.val); break;
      case 'ERRNO': out = this.printErrno(id.val); break;
      default: out = id.val; break;
    }
    if (mode !== 'raw' && out !== null) {
      if (type === 'ESCAPED_KEY' && out.includes(KEY_SEPARATOR)) {
        out = out.split(KEY_SEPARATOR).map((key) => (needsEscaping(key, mode) ? escapeText(key, mode) : key)).join(KEY_SEPARATOR);
      } else if (needsEscaping(out, mode)) out = escapeText(out, mode);
    }
    return out;
  }
}
