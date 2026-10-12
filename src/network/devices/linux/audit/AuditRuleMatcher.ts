import { K } from './tools/AuditKernelConstants';
import { MACH, carriesString, nameToSyscall, syscallToName, type RuleData } from './tools/AuditctlLib';

export const X86_64_ARCH = 0xc000003e;
const SYSCALL_SLOTS = 32 * K.AUDIT_BITMASK_SIZE;

export interface DecodedField {
  field: number;
  operator: number;
  value: number;
  text: string | null;
}

export interface DecodedRule {
  list: number;
  action: number;
  mask: Uint32Array;
  fields: DecodedField[];
  key: string | undefined;
  watchPath: string | null;
  dirPath: string | null;
  permission: number | null;
}

export interface AuditEvent {
  syscall: string;
  path?: string;
  pid: number;
  ppid: number;
  uid: number;
  euid: number;
  gid: number;
  egid: number;
  auid: number;
  session: number;
  exit: number;
  success: boolean;
  exe: string;
  arguments: readonly number[];
  inode?: { dev: number; ino: number; uid: number; gid: number; permissions: number };
}

export function decodeRule(rule: RuleData): DecodedRule {
  const fields: DecodedField[] = [];
  let offset = 0;
  let key: string | undefined;
  let watchPath: string | null = null;
  let dirPath: string | null = null;
  let permission: number | null = null;
  for (let i = 0; i < rule.fieldCount; i++) {
    const field = rule.fields[i];
    const operator = (rule.fieldflags[i] & K.AUDIT_OPERATORS) >>> 0;
    const value = rule.values[i];
    let text: string | null = null;
    if (carriesString(field)) {
      text = rule.bufferText(offset, value);
      offset += value;
    }
    if (field === K.AUDIT_FILTERKEY) key = text ?? undefined;
    else if (field === K.AUDIT_WATCH) watchPath = text;
    else if (field === K.AUDIT_DIR) dirPath = text;
    else if (field === K.AUDIT_PERM) permission = value;
    else fields.push({ field, operator, value, text });
  }
  return { list: rule.flags >>> 0, action: rule.action, mask: rule.mask, fields, key, watchPath, dirPath, permission };
}

export function syscallBit(mask: Uint32Array, number: number): boolean {
  if (number < 0 || number >= SYSCALL_SLOTS) return false;
  return (mask[number >>> 5] & (1 << (number & 31))) !== 0;
}

export function maskCoversSyscall(mask: Uint32Array, names: readonly string[]): boolean {
  for (const name of names) {
    const number = nameToSyscall(name, MACH.X86_64);
    if (number >= 0 && syscallBit(mask, number)) return true;
  }
  return false;
}

export function maskIsEmpty(mask: Uint32Array): boolean {
  return mask.every((word) => word === 0);
}

export function syscallNamesInMask(mask: Uint32Array): string[] {
  const names: string[] = [];
  for (let number = 0; number < SYSCALL_SLOTS; number++) {
    if (!syscallBit(mask, number)) continue;
    const name = syscallToName(number, MACH.X86_64);
    if (name !== null) names.push(name);
  }
  return names;
}

function compare(operator: number, left: number, right: number): boolean {
  switch (operator) {
    case K.AUDIT_EQUAL: return left === right;
    case K.AUDIT_NOT_EQUAL: return left !== right;
    case K.AUDIT_LESS_THAN: return left < right;
    case K.AUDIT_GREATER_THAN: return left > right;
    case K.AUDIT_LESS_THAN_OR_EQUAL: return left <= right;
    case K.AUDIT_GREATER_THAN_OR_EQUAL: return left >= right;
    case K.AUDIT_BIT_MASK: return (left & right) !== 0;
    case K.AUDIT_BIT_TEST: return (left & right) === right;
    default: return false;
  }
}

function numericSubject(field: number, event: AuditEvent): number | null {
  switch (field) {
    case K.AUDIT_PID: return event.pid;
    case K.AUDIT_PPID: return event.ppid;
    case K.AUDIT_UID: return event.uid;
    case K.AUDIT_EUID:
    case K.AUDIT_SUID:
    case K.AUDIT_FSUID: return event.euid;
    case K.AUDIT_GID: return event.gid;
    case K.AUDIT_EGID:
    case K.AUDIT_SGID:
    case K.AUDIT_FSGID: return event.egid;
    case K.AUDIT_LOGINUID: return event.auid;
    case K.AUDIT_SESSIONID: return event.session;
    case K.AUDIT_ARCH: return X86_64_ARCH;
    case K.AUDIT_PERS: return 0;
    case K.AUDIT_EXIT: return event.exit | 0;
    case K.AUDIT_SUCCESS: return event.success ? 1 : 0;
    case K.AUDIT_DEVMAJOR: return event.inode ? (event.inode.dev >>> 8) & 0xfff : null;
    case K.AUDIT_DEVMINOR: return event.inode ? event.inode.dev & 0xff : null;
    case K.AUDIT_INODE: return event.inode ? event.inode.ino : null;
    case K.AUDIT_OBJ_UID: return event.inode ? event.inode.uid : null;
    case K.AUDIT_OBJ_GID: return event.inode ? event.inode.gid : null;
    case K.AUDIT_FILETYPE: return null;
    case K.AUDIT_ARG0: return event.arguments[0] ?? null;
    case K.AUDIT_ARG1: return event.arguments[1] ?? null;
    case K.AUDIT_ARG2: return event.arguments[2] ?? null;
    case K.AUDIT_ARG3: return event.arguments[3] ?? null;
    default: return null;
  }
}

const COMPARED_PAIRS: Readonly<Record<number, readonly [number, number]>> = {
  [K.AUDIT_COMPARE_UID_TO_OBJ_UID]: [K.AUDIT_UID, K.AUDIT_OBJ_UID],
  [K.AUDIT_COMPARE_GID_TO_OBJ_GID]: [K.AUDIT_GID, K.AUDIT_OBJ_GID],
  [K.AUDIT_COMPARE_EUID_TO_OBJ_UID]: [K.AUDIT_EUID, K.AUDIT_OBJ_UID],
  [K.AUDIT_COMPARE_EGID_TO_OBJ_GID]: [K.AUDIT_EGID, K.AUDIT_OBJ_GID],
  [K.AUDIT_COMPARE_AUID_TO_OBJ_UID]: [K.AUDIT_LOGINUID, K.AUDIT_OBJ_UID],
  [K.AUDIT_COMPARE_SUID_TO_OBJ_UID]: [K.AUDIT_SUID, K.AUDIT_OBJ_UID],
  [K.AUDIT_COMPARE_SGID_TO_OBJ_GID]: [K.AUDIT_SGID, K.AUDIT_OBJ_GID],
  [K.AUDIT_COMPARE_FSUID_TO_OBJ_UID]: [K.AUDIT_FSUID, K.AUDIT_OBJ_UID],
  [K.AUDIT_COMPARE_FSGID_TO_OBJ_GID]: [K.AUDIT_FSGID, K.AUDIT_OBJ_GID],
  [K.AUDIT_COMPARE_UID_TO_AUID]: [K.AUDIT_UID, K.AUDIT_LOGINUID],
  [K.AUDIT_COMPARE_UID_TO_EUID]: [K.AUDIT_UID, K.AUDIT_EUID],
  [K.AUDIT_COMPARE_UID_TO_FSUID]: [K.AUDIT_UID, K.AUDIT_FSUID],
  [K.AUDIT_COMPARE_UID_TO_SUID]: [K.AUDIT_UID, K.AUDIT_SUID],
  [K.AUDIT_COMPARE_AUID_TO_FSUID]: [K.AUDIT_LOGINUID, K.AUDIT_FSUID],
  [K.AUDIT_COMPARE_AUID_TO_SUID]: [K.AUDIT_LOGINUID, K.AUDIT_SUID],
  [K.AUDIT_COMPARE_AUID_TO_EUID]: [K.AUDIT_LOGINUID, K.AUDIT_EUID],
  [K.AUDIT_COMPARE_EUID_TO_SUID]: [K.AUDIT_EUID, K.AUDIT_SUID],
  [K.AUDIT_COMPARE_EUID_TO_FSUID]: [K.AUDIT_EUID, K.AUDIT_FSUID],
  [K.AUDIT_COMPARE_SUID_TO_FSUID]: [K.AUDIT_SUID, K.AUDIT_FSUID],
  [K.AUDIT_COMPARE_GID_TO_EGID]: [K.AUDIT_GID, K.AUDIT_EGID],
  [K.AUDIT_COMPARE_GID_TO_FSGID]: [K.AUDIT_GID, K.AUDIT_FSGID],
  [K.AUDIT_COMPARE_GID_TO_SGID]: [K.AUDIT_GID, K.AUDIT_SGID],
  [K.AUDIT_COMPARE_EGID_TO_FSGID]: [K.AUDIT_EGID, K.AUDIT_FSGID],
  [K.AUDIT_COMPARE_EGID_TO_SGID]: [K.AUDIT_EGID, K.AUDIT_SGID],
  [K.AUDIT_COMPARE_SGID_TO_FSGID]: [K.AUDIT_SGID, K.AUDIT_FSGID],
};

function fieldMatches(entry: DecodedField, event: AuditEvent): boolean {
  if (entry.field === K.AUDIT_FIELD_COMPARE) {
    const pair = COMPARED_PAIRS[entry.value];
    if (pair === undefined) return false;
    const left = numericSubject(pair[0], event);
    const right = numericSubject(pair[1], event);
    if (left === null || right === null) return false;
    return compare(entry.operator, left >>> 0, right >>> 0);
  }
  if (entry.field === K.AUDIT_EXE) {
    return entry.text !== null && compare(entry.operator, entry.text === event.exe ? 0 : 1, 0);
  }
  if (entry.text !== null) return false;
  const subject = numericSubject(entry.field, event);
  if (subject === null) return false;
  if (entry.field === K.AUDIT_EXIT) return compare(entry.operator, subject, entry.value | 0);
  return compare(entry.operator, subject >>> 0, entry.value >>> 0);
}

function underDirectory(path: string, directory: string): boolean {
  const prefix = directory.endsWith('/') ? directory : `${directory}/`;
  return path === directory || path.startsWith(prefix);
}

export function pathCriteriaMatch(rule: DecodedRule, event: AuditEvent, watchedInode: number | undefined): boolean {
  if (rule.watchPath === null && rule.dirPath === null) return true;
  if (event.path === undefined) return false;
  if (rule.watchPath !== null) {
    const sameInode = watchedInode !== undefined && event.inode !== undefined && event.inode.ino === watchedInode;
    if (event.path !== rule.watchPath && !sameInode) return false;
  }
  if (rule.dirPath !== null && !underDirectory(event.path, rule.dirPath)) return false;
  return true;
}

export function fieldsMatch(rule: DecodedRule, event: AuditEvent): boolean {
  return rule.fields.every((entry) => fieldMatches(entry, event));
}

export function permissionBit(perm: 'r' | 'w' | 'x' | 'a'): number {
  return perm === 'r' ? K.AUDIT_PERM_READ : perm === 'w' ? K.AUDIT_PERM_WRITE : perm === 'x' ? K.AUDIT_PERM_EXEC : K.AUDIT_PERM_ATTR;
}
