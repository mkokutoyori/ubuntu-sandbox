/**
 * WindowsSecurityAuditProjection — reactive bridge from the Windows domain
 * event stream to the Security event log.
 *
 * `WindowsUserManager` no longer writes the audit log itself: it announces
 * account / group / logon changes on the bus. This projection subscribes to
 * that stream and turns each event into the faithful Security-log entry via
 * {@link WindowsSecurityAudit} — the manager mutates and announces, the
 * projection keeps the audit trail coherent as a pure side-effect.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { WindowsSecurityAudit } from './WindowsSecurityAudit';
import type {
  WindowsAccountChangedPayload,
  WindowsLogonEventPayload,
  WindowsLogoffEventPayload,
  WindowsGroupEventPayload,
  WindowsGroupMemberEventPayload,
  WindowsProcessEventPayload,
} from './events';

export class WindowsSecurityAuditProjection {
  private readonly subscriptions: Unsubscribe[] = [];

  constructor(
    bus: IEventBus,
    private readonly audit: WindowsSecurityAudit,
    private readonly deviceId: string,
  ) {
    this.subscriptions.push(
      bus.subscribe('windows.account.changed', (e) => this.onAccountChanged(e.payload)),
      bus.subscribe('windows.account.logon', (e) => this.onLogon(e.payload)),
      bus.subscribe('windows.account.logoff', (e) => this.onLogoff(e.payload)),
      bus.subscribe('windows.group.created', (e) => this.onGroupCreated(e.payload)),
      bus.subscribe('windows.group.deleted', (e) => this.onGroupDeleted(e.payload)),
      bus.subscribe('windows.group.membership-changed', (e) => this.onMembership(e.payload)),
      bus.subscribe('windows.process.started', (e) => this.onProcess(e.payload)),
      bus.subscribe('windows.process.stopped', (e) => this.onProcess(e.payload)),
    );
  }

  /** Detach every subscription — call before discarding the projection. */
  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
  }

  // ─── Handlers ──────────────────────────────────────────────────────────

  private onAccountChanged(p: WindowsAccountChangedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    switch (p.change) {
      case 'created': this.audit.accountCreated(p.account); break;
      case 'deleted': this.audit.accountDeleted(p.account); break;
      case 'password-reset': this.audit.passwordReset(p.account); break;
      case 'enabled': this.audit.accountEnabled(p.account); break;
      case 'disabled': this.audit.accountDisabled(p.account); break;
      case 'modified': this.audit.accountChanged(p.account); break;
    }
  }

  private onLogon(p: WindowsLogonEventPayload): void {
    if (p.deviceId !== this.deviceId) return;
    if (p.success) this.audit.logonSuccess(p.account, p.logonType);
    else this.audit.logonFailure(p.account);
  }

  private onLogoff(p: WindowsLogoffEventPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.audit.logoff(p.account);
  }

  private onGroupCreated(p: WindowsGroupEventPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.audit.groupCreated(p.group);
  }

  private onGroupDeleted(p: WindowsGroupEventPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.audit.groupDeleted(p.group);
  }

  private onMembership(p: WindowsGroupMemberEventPayload): void {
    if (p.deviceId !== this.deviceId) return;
    if (p.added) this.audit.groupMemberAdded(p.group, p.member);
    else this.audit.groupMemberRemoved(p.group, p.member);
  }

  private onProcess(p: WindowsProcessEventPayload): void {
    if (p.deviceId !== this.deviceId) return;
    if (p.started) this.audit.processCreated(p.name, p.pid);
    else this.audit.processTerminated(p.name, p.pid);
  }
}
