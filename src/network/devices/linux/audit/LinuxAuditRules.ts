import type { VirtualFileSystem } from '../VirtualFileSystem';
import type { LinuxAuditLog } from './LinuxAuditLog';
import { AUDIT_PATHS } from './LinuxAuditLog';
import { AUDIT_UNSET, encodeValue, ttyForAudit, userMessageFields } from './AuditUserMessage';
import {
  X86_64_ARCH, decodeRule, fieldsMatch, maskCoversSyscall, pathCriteriaMatch, permissionBit,
  type AuditEvent, type DecodedRule,
} from './AuditRuleMatcher';
import { compileRules } from './tools/AugenrulesTool';
import { K } from './tools/AuditKernelConstants';
import { msgTypeToName, nameToMsgType, type RuleData } from './tools/AuditctlLib';
import { x86SyscallNumber } from './tools/AuditSyscallTables';
import { AuditKernelState, newStatus } from './tools/AuditKernelState';

export type AuditEnabled = 0 | 1 | 2;
export type AuditFailureMode = 0 | 1 | 2;

export interface AuditActorContext {
  pid: number;
  ppid: number;
  uid: number;
  euid: number;
  gid: number;
  egid: number;
  auid: number;
  comm: string;
  exe: string;
  tty: string;
  success: boolean;
  cwd?: string;
}

const SYSCALL_ALIASES: Record<string, string[]> = {
  open: ['open', 'openat'],
  openat: ['open', 'openat'],
  chmod: ['chmod', 'fchmod', 'fchmodat'],
  chown: ['chown', 'fchown', 'lchown', 'fchownat'],
  unlink: ['unlink', 'unlinkat'],
  rename: ['rename', 'renameat', 'renameat2'],
  mkdir: ['mkdir', 'mkdirat'],
};

const DEFAULT_RULES_D = [
  '## First rule - delete all',
  '-D',
  '',
  '## Increase the buffers to survive stress events.',
  '## Make this bigger for busy systems',
  '-b 8192',
  '',
  '## This determine how long to wait in burst of events',
  '--backlog_wait_time 60000',
  '',
  '## Set failure mode to syslog',
  '-f 1',
  '',
].join('\n');

const FD_RETURNING: ReadonlySet<string> = new Set(['open', 'openat', 'openat2', 'creat']);
const DIRFD_FIRST: ReadonlySet<string> = new Set([
  'openat', 'openat2', 'mkdirat', 'unlinkat', 'fchmodat', 'fchownat', 'newfstatat', 'readlinkat', 'mknodat', 'utimensat', 'faccessat',
]);

const DEFAULT_ACTOR: AuditActorContext = {
  pid: 1, ppid: 0, uid: 0, euid: 0, gid: 0, egid: 0, auid: 0,
  comm: 'kernel', exe: '/sbin/init', tty: '(none)', success: true,
};

const AUDIT_DEVICE = 0xfd00;

export class LinuxAuditRules {
  readonly kernel: AuditKernelState;
  private readonly watchedInodes = new Map<RuleData, number>();
  private readonly writeHooks: Array<{ rule: RuleData; unsubscribe: () => void }> = [];
  private actorContextProvider: (() => AuditActorContext) | null = null;
  private rateWindowSecond = -1;
  private rateWindowCount = 0;

  constructor(
    private readonly auditLog: LinuxAuditLog,
    private readonly vfs: VirtualFileSystem,
  ) {
    this.vfs.mkdirp('/etc/audit', 0o755, 0, 0);
    this.vfs.mkdirp('/etc/audit/rules.d', 0o750, 0, 0);
    if (!this.vfs.exists(AUDIT_PATHS.config)) {
      this.vfs.writeFile(AUDIT_PATHS.config, defaultAuditdConf(), 0, 0, 0o037);
    }
    if (!this.vfs.exists('/etc/audit/rules.d/audit.rules')) {
      this.vfs.writeFile('/etc/audit/rules.d/audit.rules', DEFAULT_RULES_D, 0, 0, 0o037);
    }
    if (!this.vfs.exists(AUDIT_PATHS.rules)) {
      this.vfs.writeFile(AUDIT_PATHS.rules, compileRules([DEFAULT_RULES_D]), 0, 0, 0o037);
    }
    this.kernel = new AuditKernelState({ pathExists: (path) => this.vfs.exists(path) });
    this.kernel.observer = {
      ruleChanged: (op, rule, ok) => this.onRuleChanged(op, rule, ok),
      configChanged: (name, oldValue, newValue, ok) => this.onConfigChanged(name, oldValue, newValue, ok),
      userMessage: (type, text) => this.onUserMessage(type, text),
    };
    this.auditLog.setAdmission((type) => this.admit(type));
  }

  bindActorContextProvider(provider: () => AuditActorContext): void {
    this.actorContextProvider = provider;
  }

  get enabled(): AuditEnabled { return this.kernel.status.enabled as AuditEnabled; }
  get failure(): AuditFailureMode { return this.kernel.status.failure as AuditFailureMode; }
  get rate(): number { return this.kernel.status.rateLimit; }
  get backlog(): number { return this.kernel.status.backlogLimit; }
  get isLocked(): boolean { return this.kernel.status.enabled === 2; }

  private daemonActive = false;

  runAsDaemon<T>(action: () => T): T {
    const previous = this.daemonActive;
    this.daemonActive = true;
    try {
      return action();
    } finally {
      this.daemonActive = previous;
    }
  }

  private session(): number {
    return this.daemonActive ? AUDIT_UNSET : 1;
  }

  private actor(): AuditActorContext {
    if (this.daemonActive) return { ...DEFAULT_ACTOR, auid: AUDIT_UNSET, comm: 'auditd', exe: '/usr/sbin/auditd' };
    return this.actorContextProvider?.() ?? DEFAULT_ACTOR;
  }

  private onRuleChanged(op: 'add_rule' | 'remove_rule', rule: RuleData, ok: boolean): void {
    if (!ok) return;
    const decoded = decodeRule(rule);
    if (op === 'add_rule') this.hookWatch(rule, decoded);
    else this.unhookWatch(rule);
    const actor = this.actor();
    this.auditLog.record('CONFIG_CHANGE', {
      auid: actor.auid, ses: this.session(), subj: 'unconfined', op, key: decoded.key ?? '(null)', list: decoded.list, res: 1,
    });
  }

  private onConfigChanged(name: string, oldValue: number, newValue: number, ok: boolean): void {
    const actor = this.actor();
    this.auditLog.record('CONFIG_CHANGE', {
      op: 'set', [name]: newValue, old: oldValue, auid: actor.auid, ses: this.session(), subj: 'unconfined', res: ok ? 1 : 0,
    });
  }

  private onUserMessage(type: number, text: string): void {
    const actor = this.actor();
    this.auditLog.record(msgTypeToName(type) ?? 'USER', userMessageFields(
      { pid: actor.pid, uid: actor.uid, auid: actor.auid, ses: this.session() }, text,
    ));
  }

  private hookWatch(rule: RuleData, decoded: DecodedRule): void {
    if (decoded.watchPath === null || decoded.list !== K.AUDIT_FILTER_EXIT) return;
    const inode = this.vfs.resolveInode(decoded.watchPath);
    if (inode) this.watchedInodes.set(rule, inode.id);
    const writes = ((decoded.permission ?? 0) & (K.AUDIT_PERM_WRITE | K.AUDIT_PERM_ATTR)) !== 0;
    if (!writes) return;
    const path = decoded.watchPath;
    const unsubscribe = this.vfs.onWrite(path, () => this.onAccess(path, 'w', 'open'));
    this.writeHooks.push({ rule, unsubscribe });
  }

  private unhookWatch(rule: RuleData): void {
    for (let i = this.writeHooks.length - 1; i >= 0; i--) {
      if (!this.writeHooks[i].rule.sameAs(rule)) continue;
      this.writeHooks[i].unsubscribe();
      this.writeHooks.splice(i, 1);
    }
    for (const stored of [...this.watchedInodes.keys()]) if (stored.sameAs(rule)) this.watchedInodes.delete(stored);
  }

  deleteAll(): void {
    if (this.isLocked) return;
    for (const hook of this.writeHooks) hook.unsubscribe();
    this.writeHooks.length = 0;
    this.watchedInodes.clear();
    this.kernel.clearRules();
  }

  rebootReset(): void {
    for (const hook of this.writeHooks) hook.unsubscribe();
    this.writeHooks.length = 0;
    this.watchedInodes.clear();
    this.kernel.clearRules();
    this.kernel.status = newStatus();
    this.kernel.features = { vers: this.kernel.features.vers, mask: this.kernel.features.mask, features: 0, lock: 0 };
  }

  private admit(typeName: string): boolean {
    const type = nameToMsgType(typeName);
    if (type > 0) {
      if (!this.passesFilter(K.AUDIT_FILTER_EXCLUDE, type)) return false;
      const userOrigin = (type >= K.AUDIT_FIRST_USER_MSG && type <= K.AUDIT_LAST_USER_MSG)
        || (type >= K.AUDIT_FIRST_USER_MSG2 && type <= K.AUDIT_LAST_USER_MSG2) || type === K.AUDIT_USER;
      if (userOrigin && !this.passesFilter(K.AUDIT_FILTER_USER, type)) return false;
    }
    return this.passesRateLimit();
  }

  private passesFilter(list: number, type: number): boolean {
    const actor = this.actor();
    const event = this.eventFor('', undefined, actor);
    for (const rule of this.kernel.lists[list]) {
      const decoded = decodeRule(rule);
      const typeFields = decoded.fields.filter((entry) => entry.field === K.AUDIT_MSGTYPE);
      const others = { ...decoded, fields: decoded.fields.filter((entry) => entry.field !== K.AUDIT_MSGTYPE) };
      const typeOk = typeFields.every((entry) => (entry.operator === K.AUDIT_EQUAL ? entry.value === type : entry.operator === K.AUDIT_NOT_EQUAL ? entry.value !== type : false));
      if (!typeOk || !fieldsMatch(others, event)) continue;
      return rule.action !== K.AUDIT_NEVER;
    }
    return true;
  }

  private passesRateLimit(): boolean {
    const limit = this.kernel.status.rateLimit;
    if (limit <= 0) return true;
    const second = Math.floor(this.auditLog.currentTimeMs() / 1000);
    if (second !== this.rateWindowSecond) {
      this.rateWindowSecond = second;
      this.rateWindowCount = 0;
    }
    if (this.rateWindowCount >= limit) {
      this.kernel.status.lost++;
      return false;
    }
    this.rateWindowCount++;
    return true;
  }

  private eventFor(syscall: string, path: string | undefined, actor: AuditActorContext): AuditEvent {
    const inode = path !== undefined ? this.vfs.resolveInode(path) : null;
    const args = syscallArguments(syscall, path).map((hex) => parseInt(hex, 16));
    return {
      syscall, path,
      pid: actor.pid, ppid: actor.ppid, uid: actor.uid, euid: actor.euid, gid: actor.gid, egid: actor.egid,
      auid: actor.auid, session: 1,
      exit: actor.success ? (FD_RETURNING.has(syscall) ? 3 : 0) : -13,
      success: actor.success, exe: actor.exe, arguments: args,
      inode: inode ? { dev: AUDIT_DEVICE, ino: inode.id, uid: inode.uid, gid: inode.gid, permissions: inode.permissions } : undefined,
    };
  }

  private exitRules(): Array<{ source: RuleData; decoded: DecodedRule }> {
    return this.kernel.lists[K.AUDIT_FILTER_EXIT].map((source) => ({ source, decoded: decodeRule(source) }));
  }

  private firstMatch(
    event: AuditEvent,
    family: readonly string[],
    accept: (decoded: DecodedRule) => boolean,
  ): { source: RuleData; decoded: DecodedRule } | null {
    for (const entry of this.exitRules()) {
      const { source, decoded } = entry;
      if (!accept(decoded)) continue;
      if (!maskCoversSyscall(decoded.mask, family)) continue;
      if (!pathCriteriaMatch(decoded, event, this.watchedInodes.get(source))) continue;
      if (!fieldsMatch(decoded, event)) continue;
      return entry;
    }
    return null;
  }

  onAccess(path: string, perm: 'r' | 'w' | 'x' | 'a', syscallHint?: string, ctx?: AuditActorContext): void {
    if (this.kernel.status.enabled === 0) return;
    const syscall = syscallHint ?? defaultSyscallFor(perm);
    const actor = ctx ?? this.actor();
    const event = this.eventFor(syscall, path, actor);
    const bit = permissionBit(perm);
    const hit = this.firstMatch(event, SYSCALL_ALIASES[syscall] ?? [syscall],
      (decoded) => decoded.permission === null
        ? decoded.action === K.AUDIT_NEVER
        : (decoded.permission & bit) !== 0 && (decoded.watchPath !== null || decoded.dirPath !== null));
    if (hit === null || hit.source.action === K.AUDIT_NEVER) return;
    this.fire(syscall, path, hit.decoded.key, actor);
  }

  onAccessIndirect(path: string, perm: 'r' | 'w' | 'x' | 'a', syscallHint: string, ctx?: AuditActorContext): void {
    if (this.kernel.status.enabled === 0) return;
    const actor = ctx ?? this.actor();
    const event = this.eventFor(syscallHint, path, actor);
    const bit = permissionBit(perm);
    const hit = this.firstMatch(event, SYSCALL_ALIASES[syscallHint] ?? [syscallHint],
      (decoded) => decoded.permission !== null && (decoded.permission & bit) !== 0 && decoded.watchPath !== null
        && decoded.watchPath !== path);
    if (hit === null || hit.source.action === K.AUDIT_NEVER) return;
    this.fire(syscallHint, path, hit.decoded.key, actor);
  }

  onSyscall(syscall: string, path?: string, ctx?: AuditActorContext): void {
    if (this.kernel.status.enabled === 0) return;
    const actor = ctx ?? this.actor();
    const event = this.eventFor(syscall, path, actor);
    const hit = this.firstMatch(event, SYSCALL_ALIASES[syscall] ?? [syscall], (decoded) => decoded.permission === null);
    if (hit === null || hit.source.action === K.AUDIT_NEVER) return;
    this.fire(syscall, path, hit.decoded.key, actor);
  }

  private fire(syscall: string, path: string | undefined, key?: string, ctxArg?: AuditActorContext): void {
    if (this.kernel.status.enabled === 0) return;
    const ctx = ctxArg ?? this.actor();
    const exit = ctx.success ? (FD_RETURNING.has(syscall) ? 3 : 0) : -13;
    const number = x86SyscallNumber(syscall);
    const inode = path !== undefined ? this.vfs.resolveInode(path) : null;
    const args = syscallArguments(syscall, path);
    const syscallFields: Record<string, string | number> = {
      arch: X86_64_ARCH.toString(16),
      syscall: number ?? 0,
      success: ctx.success ? 'yes' : 'no',
      exit,
      a0: args[0],
      a1: args[1],
      a2: args[2],
      a3: args[3],
      items: path !== undefined ? 1 : 0,
      ppid: ctx.ppid,
      pid: ctx.pid,
      auid: ctx.auid,
      uid: ctx.uid,
      gid: ctx.gid,
      euid: ctx.euid,
      suid: ctx.euid,
      fsuid: ctx.euid,
      egid: ctx.egid,
      sgid: ctx.egid,
      fsgid: ctx.egid,
      tty: ttyForAudit(ctx.tty).replace('/', ''),
      ses: 1,
      comm: ctx.comm,
      exe: ctx.exe,
      subj: 'unconfined',
      key: key ?? '(null)',
    };
    const parts: Array<{ type: string; fields?: Record<string, string | number> }> =
      [{ type: 'SYSCALL', fields: syscallFields }, { type: 'CWD', fields: { cwd: ctx.cwd ?? '/' } }];
    if (path !== undefined) {
      parts.push({ type: 'PATH', fields: {
        item: 0,
        name: path,
        inode: inode?.id ?? 0,
        dev: 'fd:00',
        mode: inode ? `0${((inode.type === 'directory' ? 0o40000 : 0o100000) | inode.permissions).toString(8)}` : '00',
        ouid: inode?.uid ?? 0,
        ogid: inode?.gid ?? 0,
        rdev: '00:00',
        nametype: writingSyscall(syscall) ? 'NORMAL' : 'PARENT',
        cap_fp: 0, cap_fi: 0, cap_fe: 0, cap_fver: 0, cap_frootid: 0,
      } });
    }
    parts.push({ type: 'PROCTITLE', fields: { proctitle: encodeValue(ctx.comm) } });
    this.auditLog.recordEvent(parts);
  }
}

function defaultSyscallFor(perm: 'r' | 'w' | 'x' | 'a'): string {
  if (perm === 'x') return 'execve';
  if (perm === 'w') return 'open';
  if (perm === 'a') return 'chmod';
  return 'openat';
}

function pointerFor(path: string | undefined, salt: number): string {
  let h = 2166136261;
  for (const ch of `${path ?? ''}#${salt}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return `55${h.toString(16).padStart(8, '0')}${(salt * 16).toString(16).padStart(2, '0')}`;
}

function syscallArguments(syscall: string, path: string | undefined): [string, string, string, string] {
  const p0 = pointerFor(path, 0);
  const p1 = pointerFor(path, 1);
  const writing = writingSyscall(syscall);
  if (syscall === 'open') return [p0, writing ? '241' : '0', '1b6', '0'];
  if (syscall === 'openat' || syscall === 'openat2') return ['ffffff9c', p0, writing ? '241' : '0', '1b6'];
  if (syscall === 'creat') return [p0, '1b6', '0', '0'];
  if (syscall === 'execve') return [p0, p1, pointerFor(path, 2), '0'];
  if (syscall === 'mkdir' || syscall === 'chmod') return [p0, '1ed', '0', '0'];
  if (syscall === 'chown' || syscall === 'lchown') return [p0, '0', '0', '0'];
  if (syscall === 'rename' || syscall === 'link' || syscall === 'symlink') return [p0, p1, '0', '0'];
  if (DIRFD_FIRST.has(syscall)) return ['ffffff9c', p0, '0', '0'];
  return [p0, '0', '0', '0'];
}

function writingSyscall(syscall: string): boolean {
  return ['open', 'openat', 'creat', 'write', 'chmod', 'fchmod', 'fchmodat',
    'chown', 'fchown', 'mkdir', 'mkdirat', 'rmdir', 'unlink', 'unlinkat',
    'rename', 'renameat', 'renameat2', 'symlink', 'symlinkat', 'link', 'linkat',
    'truncate', 'ftruncate'].includes(syscall);
}

function defaultAuditdConf(): string {
  return [
    'local_events = yes',
    'write_logs = yes',
    'log_file = /var/log/audit/audit.log',
    'log_format = RAW',
    'log_group = adm',
    'priority_boost = 4',
    'flush = INCREMENTAL_ASYNC',
    'freq = 50',
    'max_log_file = 8',
    'num_logs = 5',
    'max_log_file_action = ROTATE',
    'space_left = 75',
    'space_left_action = SYSLOG',
    'admin_space_left = 50',
    'admin_space_left_action = SUSPEND',
    'disk_full_action = SUSPEND',
    'disk_error_action = SUSPEND',
    'backlog_limit = 64',
    'rate_limit = 0',
    'name_format = NONE',
    'verify_email = yes',
    'enable_krb5 = no',
    'krb5_principal = auditd',
    'tcp_listen_queue = 5',
    'tcp_max_per_addr = 1',
    'tcp_client_max_idle = 0',
    'transport = TCP',
    'dispatcher = /sbin/audispd',
    '',
  ].join('\n');
}

const AUDITD_VALID_KEYS: ReadonlySet<string> = new Set([
  'local_events', 'write_logs', 'log_file', 'log_format', 'log_group',
  'priority_boost', 'flush', 'freq', 'max_log_file', 'num_logs',
  'max_log_file_action', 'space_left', 'space_left_action', 'admin_space_left',
  'admin_space_left_action', 'disk_full_action', 'disk_error_action',
  'backlog_limit', 'rate_limit', 'name_format', 'verify_email', 'enable_krb5',
  'krb5_principal', 'krb5_key_file', 'tcp_listen_queue', 'tcp_max_per_addr',
  'tcp_client_max_idle', 'tcp_client_ports', 'tcp_listen_port', 'transport',
  'dispatcher', 'distribute_network', 'q_depth', 'overflow_action',
  'plugin_dir', 'use_libwrap', 'name', 'admin_space_left_action',
]);

const AUDITD_VALID_LOG_FORMATS: ReadonlySet<string> = new Set(['RAW', 'ENRICHED', 'NOLOG']);

const AUDITD_VALID_ACTIONS: ReadonlySet<string> = new Set([
  'IGNORE', 'SYSLOG', 'EXEC', 'SUSPEND', 'SINGLE', 'HALT', 'KEEP_LOGS',
  'ROTATE', 'EMAIL', 'NOTIFY',
]);

export interface AuditdConfigError {
  line: number;
  message: string;
}

export function validateAuditdConfig(content: string): AuditdConfigError | null {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith('#')) continue;
    const eq = raw.indexOf('=');
    if (eq === -1) return { line: i + 1, message: `auditd.conf: malformed line (no '='): '${raw}'` };
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (!AUDITD_VALID_KEYS.has(key)) {
      return { line: i + 1, message: `auditd.conf: unknown parameter '${key}'` };
    }
    if (key === 'log_format' && !AUDITD_VALID_LOG_FORMATS.has(value)) {
      return { line: i + 1, message: `auditd.conf: invalid log_format value '${value}'` };
    }
    if (key === 'max_log_file') {
      const n = parseInt(value, 10);
      if (!Number.isInteger(n) || n < 1) return { line: i + 1, message: `auditd.conf: max_log_file must be >= 1 (got '${value}')` };
    }
    if (key === 'num_logs') {
      const n = parseInt(value, 10);
      if (!Number.isInteger(n) || n < 1) return { line: i + 1, message: `auditd.conf: num_logs must be >= 1 (got '${value}')` };
    }
    if (key === 'freq') {
      const n = parseInt(value, 10);
      if (!Number.isInteger(n) || n < 0) return { line: i + 1, message: `auditd.conf: freq must be a non-negative integer (got '${value}')` };
    }
    if (key === 'max_log_file_action' && !AUDITD_VALID_ACTIONS.has(value)) {
      return { line: i + 1, message: `auditd.conf: invalid max_log_file_action '${value}'` };
    }
  }
  return null;
}
