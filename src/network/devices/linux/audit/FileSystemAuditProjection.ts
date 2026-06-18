import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { LinuxAuditRules } from './LinuxAuditRules';
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
    this.rules.onAccess(p.path, p.perm, p.syscall);
  }

  private onSyscallInvoked(p: SyscallInvokedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.rules.onSyscall(p.syscall, p.path);
  }
}
