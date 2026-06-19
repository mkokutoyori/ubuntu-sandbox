import type { VirtualFileSystem } from '../VirtualFileSystem';
import type { LinuxAuditLog } from './LinuxAuditLog';
import { AUDIT_PATHS } from './LinuxAuditLog';

export type AuditWatchPerm = 'r' | 'w' | 'x' | 'a';
export type AuditAction = 'always' | 'never';
export type AuditFilter = 'task' | 'exit' | 'user' | 'exclude';
export type AuditFieldOp = '=' | '!=' | '<' | '>' | '<=' | '>=';

export interface AuditField {
  name: string;
  op: AuditFieldOp;
  value: string;
}

export interface AuditWatch {
  path: string;
  perms: string;
  key?: string;
}

export interface AuditSyscallRule {
  action: AuditAction;
  filter: AuditFilter;
  syscalls: string[];
  fields: AuditField[];
  key?: string;
}

export type AuditFailureMode = 0 | 1 | 2;
export type AuditEnabled = 0 | 1 | 2;

const KNOWN_SYSCALLS: ReadonlySet<string> = new Set([
  'all',
  'read', 'write', 'open', 'openat', 'close', 'stat', 'lstat', 'fstat', 'newfstatat',
  'creat', 'unlink', 'unlinkat', 'rename', 'renameat', 'renameat2',
  'mkdir', 'mkdirat', 'rmdir', 'symlink', 'symlinkat', 'link', 'linkat', 'readlink',
  'chmod', 'fchmod', 'fchmodat', 'chown', 'fchown', 'lchown', 'fchownat',
  'truncate', 'ftruncate', 'access', 'faccessat', 'utime', 'utimes', 'utimensat',
  'mount', 'umount', 'umount2', 'pivot_root', 'chroot',
  'execve', 'execveat', 'fork', 'vfork', 'clone', 'clone3', 'exit', 'exit_group',
  'kill', 'tkill', 'tgkill', 'wait4', 'waitid',
  'setuid', 'setgid', 'setreuid', 'setregid', 'setresuid', 'setresgid',
  'setfsuid', 'setfsgid', 'setpgid', 'setsid', 'setgroups', 'capset',
  'socket', 'connect', 'accept', 'accept4', 'bind', 'listen', 'sendto', 'recvfrom',
  'sendmsg', 'recvmsg', 'shutdown', 'setsockopt', 'getsockopt',
  'init_module', 'finit_module', 'delete_module',
  'ptrace', 'reboot', 'sethostname', 'setdomainname',
  'settimeofday', 'gettimeofday', 'clock_settime', 'clock_gettime',
  'adjtimex', 'time', 'stime',
  'epoll_create', 'epoll_wait', 'select', 'pselect6', 'poll', 'ppoll',
  'pipe', 'pipe2', 'dup', 'dup2', 'dup3', 'fcntl',
]);

const KNOWN_ARCHES: ReadonlySet<string> = new Set(['b32', 'b64']);

const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  'arch', 'uid', 'gid', 'euid', 'egid', 'auid', 'suid', 'sgid', 'fsuid', 'fsgid',
  'pid', 'ppid', 'path', 'dir', 'perm', 'success', 'exit', 'msgtype', 'inode',
  'devmajor', 'devminor', 'obj_user', 'obj_role', 'obj_type', 'subj_user',
  'subj_role', 'subj_type', 'subj_sen', 'subj_clr', 'key',
  'exe', 'comm', 'ses', 'sessionid', 'fstype', 'a0', 'a1', 'a2', 'a3',
  'filetype', 'gid', 'egid',
]);

const MAX_VALID_SYSCALL_ID = 600;

const FILTER_KEYWORDS: ReadonlySet<string> = new Set(['task', 'exit', 'user', 'exclude']);
const ACTION_KEYWORDS: ReadonlySet<string> = new Set(['always', 'never']);

const MAX_KEY_LEN = 128;

export interface RuleOpResult {
  ok: boolean;
  error?: string;
}

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
}

const OK: RuleOpResult = { ok: true };
const fail = (error: string): RuleOpResult => ({ ok: false, error });
const LOCKED_MSG = 'error: audit system is in immutable mode (locked), cannot change rules until reboot';

export class LinuxAuditRules {
  private readonly watches: AuditWatch[] = [];
  private readonly syscallRules: AuditSyscallRule[] = [];
  private readonly writeUnsubs = new Map<AuditWatch, () => void>();

  private enabledFlag: AuditEnabled = 1;
  private failureFlag: AuditFailureMode = 1;
  private rateLimit = 0;
  private backlogLimit = 8192;
  private locked = false;

  private auditdPidProvider: (() => number | undefined) | null = null;
  private actorContextProvider: (() => AuditActorContext) | null = null;

  constructor(
    private readonly auditLog: LinuxAuditLog,
    private readonly vfs: VirtualFileSystem,
  ) {
    this.vfs.mkdirp('/etc/audit', 0o755, 0, 0);
    this.vfs.mkdirp('/etc/audit/rules.d', 0o750, 0, 0);
    if (!this.vfs.exists(AUDIT_PATHS.config)) {
      this.vfs.writeFile(AUDIT_PATHS.config, defaultAuditdConf(), 0, 0, 0o037);
    }
    if (!this.vfs.exists(AUDIT_PATHS.rules)) {
      this.vfs.writeFile(AUDIT_PATHS.rules, '## auditctl-managed rules\n', 0, 0, 0o037);
    }
    if (!this.vfs.exists('/etc/audit/rules.d/audit.rules')) {
      this.vfs.writeFile('/etc/audit/rules.d/audit.rules',
        '## persistent audit rules — loaded by augenrules at boot\n', 0, 0, 0o037);
    }
  }

  bindAuditdPidProvider(provider: () => number | undefined): void {
    this.auditdPidProvider = provider;
  }

  bindActorContextProvider(provider: () => AuditActorContext): void {
    this.actorContextProvider = provider;
  }

  get enabled(): AuditEnabled { return this.enabledFlag; }
  get failure(): AuditFailureMode { return this.failureFlag; }
  get rate(): number { return this.rateLimit; }
  get backlog(): number { return this.backlogLimit; }
  get isLocked(): boolean { return this.locked; }

  setEnabled(value: AuditEnabled): RuleOpResult {
    if (this.locked && value !== 2) return fail(LOCKED_MSG);
    this.enabledFlag = value;
    if (value === 2) this.locked = true;
    return OK;
  }

  setFailure(mode: AuditFailureMode): RuleOpResult {
    if (this.locked) return fail(LOCKED_MSG);
    this.failureFlag = mode;
    return OK;
  }

  setRateLimit(rate: number): RuleOpResult {
    if (this.locked) return fail(LOCKED_MSG);
    if (!Number.isInteger(rate) || rate < 0) return fail('invalid rate: must be a non-negative integer');
    this.rateLimit = rate;
    return OK;
  }

  setBacklogLimit(limit: number): RuleOpResult {
    if (this.locked) return fail(LOCKED_MSG);
    if (!Number.isInteger(limit) || limit < 0) return fail('invalid backlog limit: must be a non-negative integer');
    this.backlogLimit = limit;
    return OK;
  }

  deleteAll(): RuleOpResult {
    if (this.locked) return fail(LOCKED_MSG);
    for (const unsub of this.writeUnsubs.values()) unsub();
    this.writeUnsubs.clear();
    this.watches.length = 0;
    this.syscallRules.length = 0;
    this.persist();
    return OK;
  }

  rebootReset(): void {
    this.locked = false;
    this.enabledFlag = 1;
  }

  addWatch(path: string, permsRaw: string | undefined, key?: string): RuleOpResult {
    if (this.locked) return fail(LOCKED_MSG);
    if (!path) return fail('invalid: missing path argument');
    if (!path.startsWith('/')) return fail(`invalid path: must be absolute (got '${path}')`);
    const slash = path.lastIndexOf('/');
    const parent = slash <= 0 ? '/' : path.slice(0, slash);
    if (!this.vfs.exists(parent)) {
      return fail(`error: no such file or directory: parent '${parent}' does not exist`);
    }

    const perms = canonPerms(permsRaw ?? 'rwxa');
    if (perms === null) return fail(`invalid permission flag: ${permsRaw}`);
    const keyErr = validateKey(key);
    if (keyErr) return fail(keyErr);

    if (this.watches.some((w) => w.path === path && w.perms === perms)) {
      return fail('invalid: rule already exists');
    }

    for (let idx = this.watches.length - 1; idx >= 0; idx--) {
      if (this.watches[idx].path !== path) continue;
      this.writeUnsubs.get(this.watches[idx])?.();
      this.writeUnsubs.delete(this.watches[idx]);
      this.watches.splice(idx, 1);
    }

    const watch: AuditWatch = { path, perms, key };
    this.watches.push(watch);
    if (/[wa]/.test(perms)) {
      const unsub = this.vfs.onWrite(path, () => this.fire('open', path, key));
      this.writeUnsubs.set(watch, unsub);
    }
    this.persist();
    return OK;
  }

  removeWatch(path: string, permsRaw?: string): RuleOpResult {
    if (this.locked) return fail(LOCKED_MSG);
    if (!path) return fail('audit rule needs a path');
    const perms = permsRaw !== undefined ? canonPerms(permsRaw) : null;
    if (permsRaw !== undefined && perms === null) return fail(`Permission ${permsRaw} isn't supported`);

    const initial = this.watches.length;
    for (let i = this.watches.length - 1; i >= 0; i--) {
      const w = this.watches[i];
      if (w.path !== path) continue;
      if (perms !== null && w.perms !== perms) continue;
      this.writeUnsubs.get(w)?.();
      this.writeUnsubs.delete(w);
      this.watches.splice(i, 1);
    }
    if (this.watches.length === initial) {
      return fail(`No rules: no such rule for path ${path}`);
    }
    this.persist();
    return OK;
  }

  addSyscallRule(
    actionRaw: string,
    filterRaw: string,
    syscallsRaw: string[],
    fieldsRaw: string[],
    key: string | undefined,
    position: 'append' | 'prepend',
  ): RuleOpResult {
    if (this.locked) return fail(LOCKED_MSG);

    if (!ACTION_KEYWORDS.has(actionRaw)) return fail(`invalid action: ${actionRaw}`);
    if (!FILTER_KEYWORDS.has(filterRaw)) return fail(`invalid filter: ${filterRaw}`);

    const syscalls: string[] = [];
    for (const s of syscallsRaw) {
      if (/^-?\d+$/.test(s)) {
        const n = parseInt(s, 10);
        if (n < 0) return fail(`invalid syscall id: must be non-negative (got '${s}')`);
        if (n > MAX_VALID_SYSCALL_ID) return fail(`invalid syscall id: ${n} exceeds maximum (${MAX_VALID_SYSCALL_ID})`);
        syscalls.push(s);
        continue;
      }
      if (/[*?\[\]]/.test(s)) return fail(`invalid syscall name: shell glob characters not allowed (got '${s}')`);
      if (!KNOWN_SYSCALLS.has(s)) return fail(`unknown syscall: '${s}'`);
      syscalls.push(s);
    }

    const fields: AuditField[] = [];
    for (const raw of fieldsRaw) {
      const parsed = parseField(raw);
      if (!parsed.ok) return parsed;
      fields.push(parsed.field);
    }

    const rule: AuditSyscallRule = {
      action: actionRaw as AuditAction,
      filter: filterRaw as AuditFilter,
      syscalls,
      fields,
      key,
    };
    if (position === 'prepend') this.syscallRules.unshift(rule);
    else this.syscallRules.push(rule);
    this.persist();
    return OK;
  }

  deleteSyscallRule(
    actionRaw: string,
    filterRaw: string,
    syscallsRaw: string[],
    fieldsRaw: string[],
    key: string | undefined,
  ): RuleOpResult {
    if (this.locked) return fail(LOCKED_MSG);

    if (!ACTION_KEYWORDS.has(actionRaw)) return fail(`invalid action: ${actionRaw}`);
    if (!FILTER_KEYWORDS.has(filterRaw)) return fail(`invalid filter: ${filterRaw}`);

    const fields: AuditField[] = [];
    for (const raw of fieldsRaw) {
      const parsed = parseField(raw);
      if (!parsed.ok) return parsed;
      fields.push(parsed.field);
    }
    const wantSyscalls = [...syscallsRaw].sort().join(',');
    const wantFields = serializeFields(fields);
    for (let i = 0; i < this.syscallRules.length; i++) {
      const r = this.syscallRules[i];
      if (r.action !== actionRaw) continue;
      if (r.filter !== filterRaw) continue;
      if ([...r.syscalls].sort().join(',') !== wantSyscalls) continue;
      if (serializeFields(r.fields) !== wantFields) continue;
      if ((r.key ?? undefined) !== (key ?? undefined)) continue;
      this.syscallRules.splice(i, 1);
      this.persist();
      return OK;
    }
    return fail('error: no rule matching that criteria');
  }

  list(): string {
    if (this.watches.length === 0 && this.syscallRules.length === 0) return 'No rules';
    const lines: string[] = [];
    for (const r of this.syscallRules) lines.push(renderSyscallRule(r));
    for (const w of this.watches) lines.push(renderWatch(w));
    return lines.join('\n');
  }

  status(): string {
    const pid = this.auditdPidProvider?.() ?? 0;
    return [
      `enabled ${this.enabledFlag}`,
      `failure ${this.failureFlag}`,
      `pid ${pid}`,
      `rate_limit ${this.rateLimit}`,
      `backlog_limit ${this.backlogLimit}`,
      `lost 0`,
      `backlog ${this.auditLog.all().length}`,
    ].join('\n');
  }

  private persist(): void {
    const lines: string[] = [
      '## auditctl-managed rules',
      '-D',
      `-b ${this.backlogLimit}`,
      `-f ${this.failureFlag}`,
      `-r ${this.rateLimit}`,
    ];
    for (const r of this.syscallRules) lines.push(renderSyscallRule(r));
    for (const w of this.watches) lines.push(renderWatch(w));
    if (this.enabledFlag === 2) lines.push('-e 2');
    this.vfs.writeFile(AUDIT_PATHS.rules, lines.join('\n') + '\n', 0, 0, 0o037);
  }

  loadFromDisk(): void {
    const content = this.vfs.readFile(AUDIT_PATHS.rules);
    if (content === null) return;
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const parts = tokenize(line);
      if (parts.length === 0) continue;
      const head = parts[0];
      try {
        if (head === '-D') this.deleteAll();
        else if (head === '-e' && parts[1]) this.setEnabled(parseInt(parts[1], 10) as AuditEnabled);
        else if (head === '-f' && parts[1]) this.setFailure(parseInt(parts[1], 10) as AuditFailureMode);
        else if (head === '-r' && parts[1]) this.setRateLimit(parseInt(parts[1], 10));
        else if (head === '-b' && parts[1]) this.setBacklogLimit(parseInt(parts[1], 10));
        else if (head === '-w') this.replayWatch(parts);
        else if (head === '-a' || head === '-A') this.replaySyscall(parts, head === '-A' ? 'prepend' : 'append');
      } catch { /* malformed line — skip */ }
    }
  }

  private replayWatch(parts: string[]): void {
    const path = parts[1];
    let perms: string | undefined;
    let key: string | undefined;
    for (let i = 2; i < parts.length; i++) {
      if (parts[i] === '-p' && parts[i + 1]) { perms = parts[++i]; }
      else if (parts[i] === '-k' && parts[i + 1]) { key = parts[++i]; }
    }
    this.addWatch(path, perms, key);
  }

  private replaySyscall(parts: string[], position: 'append' | 'prepend'): void {
    const spec = (parts[1] ?? '').split(',');
    const action = spec[0] ?? 'always';
    const filter = spec[1] ?? 'exit';
    const syscalls: string[] = [];
    const fields: string[] = [];
    let key: string | undefined;
    for (let i = 2; i < parts.length; i++) {
      if (parts[i] === '-S' && parts[i + 1]) syscalls.push(parts[++i]);
      else if (parts[i] === '-F' && parts[i + 1]) fields.push(parts[++i]);
      else if (parts[i] === '-k' && parts[i + 1]) key = parts[++i];
    }
    this.addSyscallRule(action, filter, syscalls, fields, key, position);
  }

  onAccess(path: string, perm: 'r' | 'w' | 'x' | 'a', syscallHint?: string, ctx?: AuditActorContext): void {
    if (this.enabledFlag === 0) return;
    for (const w of this.watches) {
      if (!w.perms.includes(perm)) continue;
      if (path === w.path || path.startsWith(w.path.replace(/\/?$/, '/'))) {
        const syscall = syscallHint ?? defaultSyscallFor(perm);
        this.fire(syscall, path, w.key, ctx);
      }
    }
  }

  onSyscall(syscall: string, path?: string, ctx?: AuditActorContext): void {
    if (this.enabledFlag === 0) return;
    for (const r of this.syscallRules) {
      if (r.action === 'never') continue;
      if (r.syscalls.includes(syscall) || r.syscalls.includes('all')) {
        if (!this.matchesFields(r, path)) continue;
        this.fire(syscall, path, r.key, ctx);
      }
    }
  }

  private matchesFields(rule: AuditSyscallRule, path: string | undefined): boolean {
    for (const f of rule.fields) {
      if (f.name === 'path' && path !== undefined && f.op === '=' && path !== f.value) return false;
      if (f.name === 'dir' && path !== undefined && f.op === '=' && !path.startsWith(f.value.replace(/\/?$/, '/')) && path !== f.value) return false;
    }
    return true;
  }

  private fire(syscall: string, path: string | undefined, key?: string, ctxArg?: AuditActorContext): void {
    if (this.enabledFlag === 0) return;
    const ctx = ctxArg ?? this.actorContextProvider?.() ?? DEFAULT_ACTOR;
    const exit = ctx.success ? 0 : -13;
    const syscallFields: Record<string, string | number> = {
      arch: 'c000003e',
      syscall,
      success: ctx.success ? 'yes' : 'no',
      exit,
      a0: '0', a1: '0', a2: '0', a3: '0',
      items: path !== undefined ? 1 : 0,
      ppid: ctx.ppid,
      pid: ctx.pid,
      auid: ctx.auid,
      uid: ctx.uid,
      gid: ctx.gid,
      euid: ctx.euid,
      egid: ctx.egid,
      suid: ctx.euid,
      sgid: ctx.egid,
      fsuid: ctx.euid,
      fsgid: ctx.egid,
      tty: ctx.tty,
      ses: '1',
      comm: ctx.comm,
      exe: ctx.exe,
      key: key ?? '(none)',
      res: ctx.success ? 'success' : 'failed',
    };
    const parts: Array<{ type: string; fields?: Record<string, string | number> }> =
      [{ type: 'SYSCALL', fields: syscallFields }];
    if (path !== undefined) {
      parts.push({ type: 'PATH', fields: {
        item: 0,
        name: path,
        inode: '0',
        dev: '00:00',
        mode: '0100644',
        ouid: 0,
        ogid: 0,
        rdev: '00:00',
        nametype: writingSyscall(syscall) ? 'NORMAL' : 'PARENT',
      } });
    }
    this.auditLog.recordEvent(parts);
  }
}

const DEFAULT_ACTOR: AuditActorContext = {
  pid: 1, ppid: 0, uid: 0, euid: 0, gid: 0, egid: 0, auid: 0,
  comm: 'kernel', exe: '/sbin/init', tty: '(none)', success: true,
};

function defaultSyscallFor(perm: 'r' | 'w' | 'x' | 'a'): string {
  if (perm === 'x') return 'execve';
  if (perm === 'w') return 'open';
  if (perm === 'a') return 'chmod';
  return 'openat';
}

function writingSyscall(syscall: string): boolean {
  return ['open', 'openat', 'creat', 'write', 'chmod', 'fchmod', 'fchmodat',
    'chown', 'fchown', 'mkdir', 'mkdirat', 'rmdir', 'unlink', 'unlinkat',
    'rename', 'renameat', 'renameat2', 'symlink', 'symlinkat', 'link', 'linkat',
    'truncate', 'ftruncate'].includes(syscall);
}

function canonPerms(input: string): string | null {
  if (input.length === 0) return null;
  const seen = new Set<string>();
  for (const ch of input) {
    if (ch !== 'r' && ch !== 'w' && ch !== 'x' && ch !== 'a') return null;
    seen.add(ch);
  }
  let out = '';
  for (const ch of ['r', 'w', 'x', 'a'] as const) if (seen.has(ch)) out += ch;
  return out;
}

function validateKey(key: string | undefined): string | null {
  if (key === undefined) return null;
  if (key.length === 0) return 'invalid key: must not be empty';
  if (key.length > MAX_KEY_LEN) return `invalid key: length exceeds ${MAX_KEY_LEN}-character limit`;
  if (!/^[\x20-\x7e]+$/.test(key)) return 'invalid key: non-ASCII characters not allowed';
  return null;
}

interface FieldParseOk { ok: true; field: AuditField; error?: undefined }
function parseField(raw: string): FieldParseOk | (RuleOpResult & { ok: false }) {
  const ops: AuditFieldOp[] = ['!=', '<=', '>=', '=', '<', '>'];
  let op: AuditFieldOp | null = null;
  let opIdx = -1;
  for (const candidate of ops) {
    const idx = raw.indexOf(candidate);
    if (idx > 0 && (opIdx === -1 || idx < opIdx)) {
      op = candidate;
      opIdx = idx;
    }
  }
  if (op === null) return fail(`-F: invalid filter expression: ${raw}`);

  const name = raw.slice(0, opIdx);
  const value = raw.slice(opIdx + op.length);
  if (value.includes('=')) return fail(`-F: invalid operator in: ${raw}`);
  if (!KNOWN_FIELDS.has(name)) return fail(`-F: unknown field: ${name}`);

  if (name === 'arch' && !KNOWN_ARCHES.has(value)) {
    return fail(`-F: unknown architecture: ${value}`);
  }
  if (name === 'fstype' && !/^0x[0-9a-fA-F]+$/.test(value)) {
    return fail(`-F: invalid fstype: must be hex (got '${value}')`);
  }
  return { ok: true, field: { name, op, value } };
}

function serializeFields(fields: readonly AuditField[]): string {
  return [...fields].map((f) => `${f.name}${f.op}${f.value}`).sort().join('|');
}

function renderSyscallRule(r: AuditSyscallRule): string {
  const head = `-a ${r.action},${r.filter}`;
  const sc = r.syscalls.map((s) => ` -S ${s}`).join('');
  const fl = r.fields.map((f) => ` -F ${f.name}${f.op}${f.value}`).join('');
  const k = r.key ? ` -k ${r.key}` : '';
  return `${head}${sc}${fl}${k}`;
}

function renderWatch(w: AuditWatch): string {
  return `-w ${w.path} -p ${w.perms}${w.key ? ` -k ${w.key}` : ''}`;
}

function tokenize(line: string): string[] {
  return line.split(/\s+/).filter(Boolean);
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
