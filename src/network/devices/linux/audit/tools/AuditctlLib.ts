import { AUPARSE_TABLES, ERROR_MESSAGE_TABLE } from './AuparseTables';
import { K } from './AuditKernelConstants';
import { SYSCALL_TABLES, syscallNumber } from './AuditSyscallTables';
import { messageTypeToName, nameToMessageType } from './AuditEventAssembler';
import { auditNameToErrno } from './AuditErrnoTable';
import { strtolBig, strtoulBig, toI32, toU32 } from './AuditCNumbers';
import { isDigit } from './AuditCString';

export const MAX_FIELDS = K.AUDIT_MAX_FIELDS;
export const BITMASK_SIZE = K.AUDIT_BITMASK_SIZE;
export const OPERATORS = 0xf0000000 >>> 0;
export const RULE_HEADER_SIZE = 12 + 4 * BITMASK_SIZE + 4 * MAX_FIELDS * 3 + 4;

export const EAU = {
  OPMISSING: 1, FIELDUNKNOWN: 2, ARCHMISPLACED: 3, ARCHUNKNOWN: 4, ELFUNKNOWN: 5, ARCHNOBIT: 6, EXITONLY: 7, MSGTYPEUNKNOWN: 8,
  MSGTYPEEXCLUDEUSER: 9, UPGRADEFAIL: 10, STRTOOLONG: 11, MSGTYPECREDEXCLUDE: 12, OPEQNOTEQ: 13, PERMRWXA: 14, ERRUNKNOWN: 15,
  FILETYPEUNKNOWN: 16, EXITENTRYONLY: 17, KEYDEP: 19, FIELDVALMISSING: 20, FIELDVALNUM: 21, FIELDNAME: 22, COMPFIELDNAME: 24,
  COMPVAL: 25, COMPFIELDUNKNOWN: 26, COMPVALUNKNOWN: 27, FIELDTOOMANY: 28, OPEQ: 29, FIELDNOSUPPORT: 30, FIELDNOFILTER: 31,
  FILTERMISSING: 32, COMPINCOMPAT: 33, FIELDUNAVAIL: 34, FILTERNOSUPPORT: 35, FSTYPEUNKNOWN: 36, FIELDVALTOOBIG: 37, PRINT_NOTHING: 38,
} as const;

export const MACH = { X86: 0, X86_64: 1, IA64: 2, PPC64: 3, PPC: 4, S390X: 5, S390: 6, ALPHA: 7, ARM: 8, AARCH64: 9, PPC64LE: 10, IO_URING: 11 } as const;

const ELF_TABLE: ReadonlyArray<readonly [number, number]> = [
  [MACH.X86, K.AUDIT_ARCH_I386], [MACH.X86_64, K.AUDIT_ARCH_X86_64], [MACH.PPC64, K.AUDIT_ARCH_PPC64],
  [MACH.PPC64LE, K.AUDIT_ARCH_PPC64LE], [MACH.PPC, K.AUDIT_ARCH_PPC], [MACH.S390X, K.AUDIT_ARCH_S390X],
  [MACH.S390, K.AUDIT_ARCH_S390], [MACH.ARM, K.AUDIT_ARCH_ARM], [MACH.AARCH64, K.AUDIT_ARCH_AARCH64],
];

const SYSCALL_TABLE_OF_MACHINE: Readonly<Record<number, string>> = {
  [MACH.X86]: 'i386', [MACH.X86_64]: 'x86_64', [MACH.PPC64]: 'ppc', [MACH.PPC64LE]: 'ppc', [MACH.PPC]: 'ppc',
  [MACH.S390X]: 's390x', [MACH.S390]: 's390', [MACH.ARM]: 'arm', [MACH.AARCH64]: 'aarch64',
};

export class RuleData {
  flags = 0;
  action = 0;
  fieldCount = 0;
  readonly mask = new Uint32Array(BITMASK_SIZE);
  readonly fields = new Uint32Array(MAX_FIELDS);
  readonly values = new Uint32Array(MAX_FIELDS);
  readonly fieldflags = new Uint32Array(MAX_FIELDS);
  buflen = 0;
  buf: number[] = [];

  clone(): RuleData {
    const copy = new RuleData();
    copy.flags = this.flags;
    copy.action = this.action;
    copy.fieldCount = this.fieldCount;
    copy.mask.set(this.mask);
    copy.fields.set(this.fields);
    copy.values.set(this.values);
    copy.fieldflags.set(this.fieldflags);
    copy.buflen = this.buflen;
    copy.buf = [...this.buf];
    return copy;
  }

  get wireSize(): number {
    return RULE_HEADER_SIZE + this.buflen;
  }

  sameAs(other: RuleData): boolean {
    if (this.flags !== other.flags || this.action !== other.action || this.fieldCount !== other.fieldCount || this.buflen !== other.buflen) return false;
    for (let i = 0; i < BITMASK_SIZE; i++) if (this.mask[i] !== other.mask[i]) return false;
    for (let i = 0; i < MAX_FIELDS; i++) {
      if (this.fields[i] !== other.fields[i] || this.values[i] !== other.values[i] || this.fieldflags[i] !== other.fieldflags[i]) return false;
    }
    return this.buf.every((b, i) => b === other.buf[i]);
  }

  bufferText(offset: number, length: number): string {
    return new TextDecoder().decode(Uint8Array.from(this.buf.slice(offset, offset + length)));
  }
}

export interface LibEnv {
  stderr(text: string): void;
  message(priority: number, text: string): void;
  lookupUser(name: string): number | null;
  lookupGroup(name: string): number | null;
  features(): number;
  detectMachine(): number;
}

export class RuleBuildState {
  elf = 0;
  syscallAdded = false;
  permAdded = false;
  archAdded = false;
  exeAdded = false;
  filterFsAdded = false;

  reset(): void {
    this.elf = 0;
    this.syscallAdded = false;
    this.permAdded = false;
    this.archAdded = false;
    this.exeAdded = false;
    this.filterFsAdded = false;
  }
}

function s2i(table: string, name: string): number | null {
  for (const [value, text] of AUPARSE_TABLES[table]) if (text === name) return value;
  return null;
}

function i2s(table: string, value: number): string | null {
  for (const [v, text] of AUPARSE_TABLES[table]) if (v === value) return text;
  return null;
}

export const nameToField = (name: string): number => s2i('field', name) ?? -1;
export const fieldToName = (field: number): string | null => i2s('field', field);
export const operatorToSymbol = (op: number): string => i2s('op', op >>> 0) ?? '';
export const nameToFlag = (name: string): number => s2i('filter_list', name) ?? -1;
export const flagToName = (flag: number): string | null => i2s('filter_list', flag);
export const actionToName = (action: number): string | null => i2s('action', action);
export const nameToFtype = (name: string): number => s2i('ftype', name) ?? -1;
export const nameToFstype = (name: string): number => s2i('fstype', name) ?? -1;
export const fstypeToName = (fstype: number): string | null => i2s('fstype', fstype);
export const nameToMachine = (name: string): number => s2i('machine', name) ?? -1;
export const machineToName = (machine: number): string | null => i2s('machine', machine);

export { errnoToName, auditNameToErrno as nameToErrno } from './AuditErrnoTable';

export const msgTypeToName = messageTypeToName;
export const nameToMsgType = nameToMessageType;

export class CString {
  constructor(public value: string) {}
}

export function elfToMachine(elf: number): number {
  for (const [machine, value] of ELF_TABLE) if ((value >>> 0) === (elf >>> 0)) return machine;
  return -1;
}

export function machineToElf(machine: number): number {
  for (const [key, value] of ELF_TABLE) if (key === machine) return value >>> 0;
  return 0;
}

export function syscallToName(syscall: number, machine: number): string | null {
  const table = SYSCALL_TABLE_OF_MACHINE[machine];
  return table === undefined ? null : (SYSCALL_TABLES[table][syscall] ?? null);
}

export function nameToSyscall(name: string, machine: number): number {
  const table = SYSCALL_TABLE_OF_MACHINE[machine];
  if (table === undefined) return -1;
  return syscallNumber(table, name) ?? -1;
}

export function uringOpToName(op: number): string | null {
  return SYSCALL_TABLES.uringop[op] ?? null;
}

export function nameToUringOp(name: string): number {
  return syscallNumber('uringop', name) ?? -1;
}

export function determineMachine(arch: string): number {
  const bits64 = 0x80000000;
  let bits = 0;
  let machine: number;
  const lower = arch.toLowerCase();
  if (lower === 'b64') {
    bits = bits64;
    machine = -2;
  } else if (lower === 'b32') {
    bits = (~bits64) >>> 0;
    machine = -2;
  } else {
    machine = nameToMachine(arch);
    if (machine < 0) {
      const ival = Number(BigInt.asUintN(32, strtoulBig(arch, 16)));
      machine = elfToMachine(ival);
    }
  }
  return finishMachine(machine, bits, bits64);
}

let detectedMachine: number = MACH.X86_64;

export function setDetectedMachine(machine: number): void {
  detectedMachine = machine;
}

export function detectMachine(): number {
  return detectedMachine;
}

function finishMachine(machineIn: number, bits: number, bits64: number): number {
  let machine = machineIn;
  if (machine === -2) machine = detectMachine();
  if (machine < 0) return -4;
  const not64 = (~bits64) >>> 0;
  if (bits === not64 && machine === MACH.X86_64) machine = MACH.X86;
  else if (bits === not64 && machine === MACH.PPC64) machine = MACH.PPC;
  else if (bits === not64 && machine === MACH.S390X) machine = MACH.S390;
  else if (bits === not64 && machine === MACH.AARCH64) machine = MACH.ARM;
  switch (machine) {
    case MACH.X86:
    case MACH.PPC:
    case MACH.S390:
    case MACH.ARM:
      if (bits === bits64) return -6;
      break;
    case MACH.AARCH64:
    case MACH.PPC64LE:
      if (bits && bits !== bits64) return -6;
      break;
    case MACH.X86_64:
    case MACH.PPC64:
    case MACH.S390X:
    case MACH.IO_URING:
      break;
    default:
      return -6;
  }
  return machine;
}

export function numberToErrmsg(env: LibEnv, errnumber: number, opt: string): void {
  for (const [key, position, text] of ERROR_MESSAGE_TABLE) {
    if (key !== errnumber) continue;
    if (position === 0) env.stderr(`${text}\n`);
    else if (position === 1) env.stderr(`${opt} ${text}\n`);
    else if (position === 2) env.stderr(`${text} ${opt}\n`);
    return;
  }
}

export function ruleSyscall(state: RuleBuildState, rule: RuleData, scall: number): number {
  const word = scall >>> 5;
  const bit = (1 << (scall & 31)) >>> 0;
  if (word > BITMASK_SIZE - 1) return -1;
  rule.mask[word] |= bit;
  state.syscallAdded = true;
  return 0;
}

export function ruleSyscallByName(env: LibEnv, state: RuleBuildState, rule: RuleData, scall: string): number {
  if (scall === 'all') {
    for (let i = 0; i < BITMASK_SIZE; i++) rule.mask[i] = 0xffffffff;
    return 0;
  }
  const machine = state.elf === 0 ? env.detectMachine() : elfToMachine(state.elf);
  if (machine < 0) return -2;
  let nr = nameToSyscall(scall, machine);
  if (nr < 0 && isDigit(scall[0])) nr = Number(strtolBig(scall, 0));
  if (nr >= 0) return ruleSyscall(state, rule, nr);
  return -1;
}

export function ruleUringByName(state: RuleBuildState, rule: RuleData, scall: string): number {
  if (scall === 'all') {
    let rc = 0;
    for (let i = 0; i < IORING_OP_LAST && rc === 0; i++) if (uringOpToName(i) !== null) rc = ruleSyscall(state, rule, i);
    return rc;
  }
  let nr = nameToUringOp(scall);
  if (nr < 0 && isDigit(scall[0])) nr = Number(strtolBig(scall, 0));
  if (nr >= 0) return ruleSyscall(state, rule, nr);
  return -1;
}

export function addWatchDir(state: RuleBuildState, env: LibEnv, rule: RuleData, type: number, path: string): boolean {
  const bytes = [...new TextEncoder().encode(path)];
  if (rule.fieldCount) {
    env.message(3, 'Rule is not empty\n');
    return false;
  }
  if (type !== K.AUDIT_WATCH && type !== K.AUDIT_DIR) {
    env.message(3, 'Invalid type used\n');
    return false;
  }
  rule.flags = K.AUDIT_FILTER_EXIT;
  rule.action = K.AUDIT_ALWAYS;
  ruleSyscallByName(env, state, rule, 'all');
  rule.fieldCount = 2;
  rule.fields[0] = type;
  rule.values[0] = bytes.length;
  rule.fieldflags[0] = K.AUDIT_EQUAL;
  rule.buflen = bytes.length;
  rule.buf = bytes;
  rule.fields[1] = K.AUDIT_PERM;
  rule.fieldflags[1] = K.AUDIT_EQUAL;
  rule.values[1] = K.AUDIT_PERM_READ | K.AUDIT_PERM_WRITE | K.AUDIT_PERM_EXEC | K.AUDIT_PERM_ATTR;
  state.permAdded = true;
  return true;
}

export function updateWatchPerms(env: LibEnv, rule: RuleData, perms: number): number {
  if (rule.fieldCount < 1) {
    env.message(3, 'Permissions should be preceeded by other fields');
    return -1;
  }
  let done = false;
  for (let i = 0; i < rule.fieldCount; i++) {
    if (rule.fields[i] === K.AUDIT_PERM) {
      rule.values[i] = perms;
      done = true;
    }
  }
  if (!done) {
    if (rule.fieldCount >= MAX_FIELDS - 1) {
      env.message(3, 'Too many fields when adding permissions');
      return -2;
    }
    rule.fields[rule.fieldCount] = K.AUDIT_PERM;
    rule.fieldflags[rule.fieldCount] = K.AUDIT_EQUAL;
    rule.values[rule.fieldCount] = perms;
    rule.fieldCount++;
  }
  return 0;
}

const COMPARE_PAIRS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  euid: { loginuid: 'AUID_TO_EUID', fsuid: 'EUID_TO_FSUID', obj_uid: 'EUID_TO_OBJ_UID', suid: 'EUID_TO_SUID', uid: 'UID_TO_EUID' },
  fsuid: { loginuid: 'AUID_TO_FSUID', euid: 'EUID_TO_FSUID', obj_uid: 'FSUID_TO_OBJ_UID', suid: 'SUID_TO_FSUID', uid: 'UID_TO_FSUID' },
  loginuid: { euid: 'AUID_TO_EUID', fsuid: 'AUID_TO_FSUID', obj_uid: 'AUID_TO_OBJ_UID', suid: 'AUID_TO_SUID', uid: 'UID_TO_AUID' },
  suid: { loginuid: 'AUID_TO_SUID', euid: 'EUID_TO_SUID', fsuid: 'SUID_TO_FSUID', obj_uid: 'SUID_TO_OBJ_UID', uid: 'UID_TO_SUID' },
  obj_uid: { loginuid: 'AUID_TO_OBJ_UID', euid: 'EUID_TO_OBJ_UID', fsuid: 'FSUID_TO_OBJ_UID', uid: 'UID_TO_OBJ_UID', suid: 'SUID_TO_OBJ_UID' },
  uid: { loginuid: 'UID_TO_AUID', euid: 'UID_TO_EUID', fsuid: 'UID_TO_FSUID', obj_uid: 'UID_TO_OBJ_UID', suid: 'UID_TO_SUID' },
  egid: { fsgid: 'EGID_TO_FSGID', gid: 'GID_TO_EGID', obj_gid: 'EGID_TO_OBJ_GID', sgid: 'EGID_TO_SGID' },
  fsgid: { sgid: 'SGID_TO_FSGID', gid: 'GID_TO_FSGID', obj_gid: 'FSGID_TO_OBJ_GID', egid: 'EGID_TO_FSGID' },
  gid: { egid: 'GID_TO_EGID', fsgid: 'GID_TO_FSGID', obj_gid: 'GID_TO_OBJ_GID', sgid: 'GID_TO_SGID' },
  obj_gid: { egid: 'EGID_TO_OBJ_GID', fsgid: 'FSGID_TO_OBJ_GID', gid: 'GID_TO_OBJ_GID', sgid: 'SGID_TO_OBJ_GID' },
  sgid: { fsgid: 'SGID_TO_FSGID', gid: 'GID_TO_SGID', obj_gid: 'SGID_TO_OBJ_GID', egid: 'EGID_TO_SGID' },
};

function indexOfOperator(text: string, operator: string): number {
  return text.indexOf(operator);
}

export function ruleInterfieldCompare(env: LibEnv, rule: RuleData, cstr: CString | null, flags: number): number {
  if (cstr === null) return -EAU.FILTERMISSING;
  const pair = cstr.value;
  if (rule.fieldCount >= MAX_FIELDS - 1) return -EAU.FIELDTOOMANY;
  let split = indexOfOperator(pair, '!=');
  let op: number;
  let f: string;
  let v: string;
  if (split >= 0) {
    f = pair.slice(0, split);
    v = pair.slice(split + 2);
    op = K.AUDIT_NOT_EQUAL;
  } else {
    split = indexOfOperator(pair, '=');
    if (split < 0) return -EAU.OPEQNOTEQ;
    f = pair.slice(0, split);
    v = pair.slice(split + 1);
    op = K.AUDIT_EQUAL;
  }
  cstr.value = f;
  if (f === '') return -EAU.COMPFIELDNAME;
  if (v === '') return -EAU.COMPVAL;
  const field1 = nameToField(f);
  if (field1 < 0) return -EAU.COMPFIELDUNKNOWN;
  const field2 = nameToField(v);
  if (field2 < 0) return -EAU.COMPVALUNKNOWN;
  if (flags !== K.AUDIT_FILTER_EXIT) return -EAU.EXITONLY;
  rule.fields[rule.fieldCount] = K.AUDIT_FIELD_COMPARE;
  rule.fieldflags[rule.fieldCount] = op;
  const left = fieldToName(field1) ?? '';
  const rightName = fieldToName(field2) ?? '';
  const row = COMPARE_PAIRS[left === 'auid' ? 'loginuid' : left];
  const target = row?.[rightName === 'auid' ? 'loginuid' : rightName];
  if (target === undefined) return -EAU.COMPINCOMPAT;
  rule.values[rule.fieldCount] = K[`AUDIT_COMPARE_${target}`];
  rule.fieldCount++;
  void env;
  return 0;
}

const UID_FIELDS: ReadonlySet<number> = new Set([K.AUDIT_UID, K.AUDIT_EUID, K.AUDIT_SUID, K.AUDIT_FSUID, K.AUDIT_LOGINUID, K.AUDIT_OBJ_UID]);
const GID_FIELDS: ReadonlySet<number> = new Set([K.AUDIT_GID, K.AUDIT_EGID, K.AUDIT_SGID, K.AUDIT_FSGID, K.AUDIT_OBJ_GID]);
const STRING_FIELDS: ReadonlySet<number> = new Set([
  K.AUDIT_OBJ_USER, K.AUDIT_OBJ_ROLE, K.AUDIT_OBJ_TYPE, K.AUDIT_OBJ_LEV_LOW, K.AUDIT_OBJ_LEV_HIGH, K.AUDIT_WATCH, K.AUDIT_DIR,
  K.AUDIT_SUBJ_USER, K.AUDIT_SUBJ_ROLE, K.AUDIT_SUBJ_TYPE, K.AUDIT_SUBJ_SEN, K.AUDIT_SUBJ_CLR, K.AUDIT_FILTERKEY, K.AUDIT_EXE,
]);

const PATH_MAX = 4096;
const IORING_OP_LAST = 64;
const AF_MAX = 46;

export function ruleFieldPair(env: LibEnv, state: RuleBuildState, rule: RuleData, cstr: CString | null, flags: number): number {
  if (cstr === null) return -EAU.FILTERMISSING;
  const pair = cstr.value;
  if (rule.fieldCount >= MAX_FIELDS - 1) return -EAU.FIELDTOOMANY;
  const operators: ReadonlyArray<readonly [string, number]> = [
    ['!=', K.AUDIT_NOT_EQUAL], ['>=', K.AUDIT_GREATER_THAN_OR_EQUAL], ['<=', K.AUDIT_LESS_THAN_OR_EQUAL], ['&=', K.AUDIT_BIT_TEST],
    ['=', K.AUDIT_EQUAL], ['>', K.AUDIT_GREATER_THAN], ['<', K.AUDIT_LESS_THAN], ['&', K.AUDIT_BIT_MASK],
  ];
  let f = pair;
  let v: string | null = null;
  let op = 0;
  for (const [symbol, value] of operators) {
    const at = pair.indexOf(symbol);
    if (at >= 0) {
      f = pair.slice(0, at);
      v = pair.slice(at + symbol.length);
      op = value;
      break;
    }
  }
  if (v === null) return -EAU.OPMISSING;
  cstr.value = f;
  if (f === '') return -EAU.FIELDNAME;
  if (v === '') return -EAU.FIELDVALMISSING;
  const field = nameToField(f);
  if (field < 0) return -EAU.FIELDUNKNOWN;
  if (flags === K.AUDIT_FILTER_EXCLUDE) {
    if ((env.features() & K.AUDIT_FEATURE_BITMAP_EXCLUDE_EXTEND) === 0) {
      const allowed: readonly number[] = [
        K.AUDIT_PID, K.AUDIT_UID, K.AUDIT_GID, K.AUDIT_LOGINUID, K.AUDIT_MSGTYPE, K.AUDIT_SUBJ_USER, K.AUDIT_SUBJ_ROLE,
        K.AUDIT_SUBJ_TYPE, K.AUDIT_SUBJ_SEN, K.AUDIT_SUBJ_CLR, K.AUDIT_EXE,
      ];
      if (!allowed.includes(field)) return -EAU.MSGTYPECREDEXCLUDE;
    }
  }
  if (flags === K.AUDIT_FILTER_FS) {
    if ((env.features() & K.AUDIT_FEATURE_BITMAP_FILTER_FS) === 0) return -EAU.FILTERNOSUPPORT;
  }
  const at = rule.fieldCount;
  rule.fields[at] = field;
  rule.fieldflags[at] = op;
  const negativeNumber = (text: string): boolean => text.length >= 2 && text[0] === '-' && isDigit(text[1]);
  if (UID_FIELDS.has(field)) {
    if (isDigit(v[0])) rule.values[at] = toU32(strtoulBig(v, 0));
    else if (negativeNumber(v)) rule.values[at] = toU32(strtolBig(v, 0));
    else if (v === 'unset') rule.values[at] = 4294967295;
    else {
      const uid = env.lookupUser(v);
      if (uid === null) {
        env.message(3, `Unknown user: ${v}`);
        return -EAU.PRINT_NOTHING;
      }
      rule.values[at] = uid;
    }
  } else if (GID_FIELDS.has(field)) {
    if (isDigit(v[0])) rule.values[at] = toU32(strtolBig(v, 0));
    else {
      const gid = env.lookupGroup(v);
      if (gid === null) {
        env.message(3, `Unknown group: ${v}`);
        return -EAU.PRINT_NOTHING;
      }
      rule.values[at] = gid;
    }
  } else if (field === K.AUDIT_EXIT) {
    if (flags !== K.AUDIT_FILTER_EXIT) return -EAU.EXITONLY;
    if (isDigit(v[0]) || negativeNumber(v)) rule.values[at] = toU32(strtolBig(v, 0));
    else {
      rule.values[at] = auditNameToErrno(v) >>> 0;
      if (rule.values[at] === 0) return -EAU.ERRUNKNOWN;
    }
  } else if (field === K.AUDIT_MSGTYPE) {
    if (flags !== K.AUDIT_FILTER_EXCLUDE && flags !== K.AUDIT_FILTER_USER) return -EAU.MSGTYPEEXCLUDEUSER;
    if (isDigit(v[0])) rule.values[at] = toU32(strtolBig(v, 0));
    else if (nameToMsgType(v) > 0) rule.values[at] = nameToMsgType(v);
    else return -EAU.MSGTYPEUNKNOWN;
  } else if (STRING_FIELDS.has(field) || (field >= K.AUDIT_SUBJ_USER && field <= K.AUDIT_OBJ_LEV_HIGH && field !== K.AUDIT_PPID)) {
    if (field === K.AUDIT_OBJ_USER || field === K.AUDIT_OBJ_ROLE || field === K.AUDIT_OBJ_TYPE || field === K.AUDIT_OBJ_LEV_LOW
      || field === K.AUDIT_OBJ_LEV_HIGH || field === K.AUDIT_WATCH || field === K.AUDIT_DIR) {
      if (flags !== K.AUDIT_FILTER_EXIT) return -EAU.EXITONLY;
      if (field === K.AUDIT_WATCH || field === K.AUDIT_DIR) state.permAdded = true;
    }
    if (field === K.AUDIT_EXE) {
      if ((env.features() & K.AUDIT_FEATURE_BITMAP_EXECUTABLE_PATH) === 0) return -EAU.FIELDNOSUPPORT;
      if (!(op === K.AUDIT_NOT_EQUAL || op === K.AUDIT_EQUAL)) return -EAU.OPEQNOTEQ;
      state.exeAdded = true;
    }
    if (field === K.AUDIT_FILTERKEY && !(state.syscallAdded || state.permAdded || state.exeAdded || state.filterFsAdded)) return -EAU.KEYDEP;
    const bytes = [...new TextEncoder().encode(v)];
    if (field === K.AUDIT_FILTERKEY && bytes.length > K.AUDIT_MAX_KEY_LEN) return -EAU.STRTOOLONG;
    else if (bytes.length > PATH_MAX) return -EAU.STRTOOLONG;
    rule.values[at] = bytes.length;
    rule.buflen += bytes.length;
    rule.buf.push(...bytes);
  } else if (field === K.AUDIT_ARCH) {
    if (state.syscallAdded) return -EAU.ARCHMISPLACED;
    if (!(op === K.AUDIT_NOT_EQUAL || op === K.AUDIT_EQUAL)) return -EAU.OPEQNOTEQ;
    if (isDigit(v[0])) {
      state.elf = toU32(strtoulBig(v, 0));
      if (elfToMachine(state.elf) < 0) return -EAU.ELFUNKNOWN;
    } else {
      const machine = determineMachine(v);
      const elf = machine < 0 ? 0 : machineToElf(machine);
      if (elf === 0) return -EAU.ELFUNKNOWN;
      state.elf = elf;
    }
    rule.values[at] = state.elf;
    state.archAdded = true;
  } else if (field === K.AUDIT_PERM) {
    if (!(flags === K.AUDIT_FILTER_EXIT || flags === K.AUDIT_FILTER_EXCLUDE)) return -EAU.EXITONLY;
    if (op !== K.AUDIT_EQUAL) return -EAU.OPEQ;
    if (v.length > 4) return -EAU.STRTOOLONG;
    let val = 0;
    for (const ch of v.toLowerCase()) {
      if (ch === 'r') val |= K.AUDIT_PERM_READ;
      else if (ch === 'w') val |= K.AUDIT_PERM_WRITE;
      else if (ch === 'x') val |= K.AUDIT_PERM_EXEC;
      else if (ch === 'a') val |= K.AUDIT_PERM_ATTR;
      else return -EAU.PERMRWXA;
    }
    rule.values[at] = val;
  } else if (field === K.AUDIT_FILETYPE) {
    if (flags !== K.AUDIT_FILTER_EXIT) return -EAU.EXITONLY;
    const ftype = nameToFtype(v);
    rule.values[at] = ftype >>> 0;
    if (ftype < 0) return -EAU.FILETYPEUNKNOWN;
  } else if (field === K.AUDIT_FSTYPE) {
    if (flags !== K.AUDIT_FILTER_FS) return -EAU.FIELDUNAVAIL;
    if (!(op === K.AUDIT_NOT_EQUAL || op === K.AUDIT_EQUAL)) return -EAU.OPEQNOTEQ;
    const value = isDigit(v[0]) ? toU32(strtoulBig(v, 0)) : nameToFstype(v) >>> 0;
    rule.values[at] = value;
    if (toI32(BigInt(value)) === -1) return -EAU.FSTYPEUNKNOWN;
    state.filterFsAdded = true;
  } else if (field >= K.AUDIT_ARG0 && field <= K.AUDIT_ARG3) {
    if (isDigit(v[0])) rule.values[at] = toU32(strtoulBig(v, 0));
    else if (negativeNumber(v)) rule.values[at] = toU32(strtolBig(v, 0));
    else return -EAU.FIELDVALNUM;
  } else if (field === K.AUDIT_SESSIONID) {
    if ((env.features() & K.AUDIT_FEATURE_BITMAP_SESSIONID_FILTER) === 0) return -EAU.FIELDNOSUPPORT;
    if (flags !== K.AUDIT_FILTER_EXCLUDE && flags !== K.AUDIT_FILTER_USER && flags !== K.AUDIT_FILTER_EXIT) return -EAU.FIELDNOFILTER;
    if (isDigit(v[0])) rule.values[at] = toU32(strtoulBig(v, 0));
    else if (negativeNumber(v)) rule.values[at] = toU32(strtolBig(v, 0));
    else if (v === 'unset') rule.values[at] = 4294967295;
  } else if (field === K.AUDIT_SADDR_FAM) {
    const family = toU32(strtoulBig(v, 0));
    rule.values[at] = family;
    if (family >= AF_MAX) return -EAU.FIELDVALTOOBIG;
  } else {
    if ((field >= K.AUDIT_DEVMAJOR && field <= K.AUDIT_INODE) || field === K.AUDIT_SUCCESS) {
      if (flags !== K.AUDIT_FILTER_EXIT) return -EAU.EXITONLY;
    }
    if (field === K.AUDIT_INODE && !(op === K.AUDIT_NOT_EQUAL || op === K.AUDIT_EQUAL)) return -EAU.OPEQNOTEQ;
    if (field === K.AUDIT_PPID && flags !== K.AUDIT_FILTER_EXIT) return -EAU.EXITONLY;
    if (!isDigit(v[0])) return -EAU.FIELDVALNUM;
    rule.values[at] = field === K.AUDIT_INODE ? toU32(strtoulBig(v, 0)) : toU32(strtolBig(v, 0));
  }
  rule.fieldCount++;
  return 0;
}
