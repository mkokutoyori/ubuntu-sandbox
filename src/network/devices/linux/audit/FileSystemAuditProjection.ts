import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { LinuxAuditRules, AuditActorContext } from './LinuxAuditRules';
import type { FileAccessedPayload, SyscallInvokedPayload } from '../events';

export class FileSystemAuditProjection {
  private readonly subscriptions: Unsubscribe[] = [];

  constructor(
    bus: IEventBus,
    private readonly rules: LinuxAuditRules,
    private readonly deviceId: string,
  ) {
    this.subscriptions.push(
      bus.subscribe('linux.fs.accessed', (e) => this.onFileAccessed(e.payload)),
      bus.subscribe('linux.syscall.invoked', (e) => this.onSyscallInvoked(e.payload)),
    );
  }

  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
  }

  private onFileAccessed(p: FileAccessedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.rules.onAccess(p.path, p.perm, p.syscall, toContext(p));
  }

  private onSyscallInvoked(p: SyscallInvokedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.rules.onSyscall(p.syscall, p.path, toContext(p));
  }
}

function toContext(p: FileAccessedPayload | SyscallInvokedPayload): AuditActorContext {
  return {
    pid: p.pid, ppid: p.ppid, uid: p.uid, euid: p.euid, gid: p.gid, egid: p.egid,
    auid: p.auid, comm: p.comm, exe: p.exe, tty: p.tty, success: p.success,
  };
}
