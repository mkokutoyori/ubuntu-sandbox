import type { VirtualFileSystem } from '../VirtualFileSystem';
import type { LinuxAuditLog } from './LinuxAuditLog';

export interface AuditWatch {
  path: string;
  perms: string;
  key?: string;
}

export interface AuditSyscallRule {
  action: string;
  filter: string;
  syscalls: string[];
  key?: string;
}

/**
 * LinuxAuditRules — the kernel audit rule set (`auditctl`): file/directory
 * watches and syscall rules, plus the access-time triggering that appends
 * SYSCALL/PATH records to {@link LinuxAuditLog} when a watched object is
 * touched. Watches with write perms hook the VFS write notifications;
 * read/exec/unlink accesses are reported by the command layer.
 */
export class LinuxAuditRules {
  private readonly watches: AuditWatch[] = [];
  private readonly syscallRules: AuditSyscallRule[] = [];
  private readonly writeUnsubs = new Map<AuditWatch, () => void>();
  private enabledFlag = 1;

  constructor(private readonly auditLog: LinuxAuditLog, private readonly vfs: VirtualFileSystem) {}

  get enabled(): number { return this.enabledFlag; }
  setEnabled(n: number): void { this.enabledFlag = n; }

  addWatch(path: string, perms: string, key?: string): string | null {
    if (!/^[rwxa]+$/.test(perms)) return `auditctl: invalid permissions: ${perms}`;
    const watch: AuditWatch = { path, perms, key };
    this.watches.push(watch);
    if (/[wa]/.test(perms)) {
      const unsub = this.vfs.onWrite(path, () => this.fire('open', path, key));
      this.writeUnsubs.set(watch, unsub);
    }
    return null;
  }

  removeWatch(path: string): void {
    for (let i = this.watches.length - 1; i >= 0; i--) {
      if (this.watches[i].path === path) {
        this.writeUnsubs.get(this.watches[i])?.();
        this.writeUnsubs.delete(this.watches[i]);
        this.watches.splice(i, 1);
      }
    }
  }

  addSyscallRule(rule: AuditSyscallRule): void {
    this.syscallRules.push(rule);
  }

  deleteAll(): void {
    for (const unsub of this.writeUnsubs.values()) unsub();
    this.writeUnsubs.clear();
    this.watches.length = 0;
    this.syscallRules.length = 0;
  }

  list(): string {
    if (this.watches.length === 0 && this.syscallRules.length === 0) return 'No rules';
    const lines: string[] = [];
    for (const w of this.watches) {
      lines.push(`-w ${w.path} -p ${w.perms}${w.key ? ` -k ${w.key}` : ''}`);
    }
    for (const r of this.syscallRules) {
      lines.push(`-a ${r.action},${r.filter}${r.syscalls.map((s) => ` -S ${s}`).join('')}${r.key ? ` -k ${r.key}` : ''}`);
    }
    return lines.join('\n');
  }

  status(): string {
    return [
      `enabled ${this.enabledFlag}`,
      'failure 1',
      'pid 612',
      'rate_limit 0',
      'backlog_limit 8192',
      'lost 0',
      `backlog ${this.auditLog.all().length}`,
    ].join('\n');
  }

  /** Report a file/dir access from the command layer (read/exec/unlink). */
  onAccess(path: string, perm: 'r' | 'w' | 'x'): void {
    if (this.enabledFlag === 0) return;
    for (const w of this.watches) {
      if (!w.perms.includes(perm)) continue;
      if (path === w.path || path.startsWith(w.path.replace(/\/?$/, '/'))) {
        this.fire(perm === 'x' ? 'execve' : perm === 'w' ? 'open' : 'openat', path, w.key);
      }
    }
  }

  /** Report a syscall from the command layer; matches `-S` rules. */
  onSyscall(syscall: string, path?: string): void {
    if (this.enabledFlag === 0) return;
    for (const r of this.syscallRules) {
      if (r.syscalls.includes(syscall)) this.fire(syscall, path, r.key);
    }
  }

  private fire(syscall: string, path: string | undefined, key?: string): void {
    if (this.enabledFlag === 0) return;
    const fields: Record<string, string | number> = {
      arch: 'c000003e', syscall, success: 'yes', exit: 0, key: key ?? '(none)',
    };
    if (path !== undefined) { fields.exe = path; fields.name = path; }
    this.auditLog.record('SYSCALL', fields);
  }
}
