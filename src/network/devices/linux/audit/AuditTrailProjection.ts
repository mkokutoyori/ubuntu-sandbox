/**
 * AuditTrailProjection — reactive bridge from the domain event stream to the
 * kernel audit log.
 *
 * `auditd` does not poll: it records security-relevant events as they
 * happen. This projection reproduces that — it subscribes to the IAM and
 * service-lifecycle event streams and turns each event into the faithful
 * `auditd` record type a real host would write to `/var/log/audit/audit.log`:
 *
 *   account add/delete    → ADD_USER / DEL_USER
 *   password change       → USER_CHAUTHTOK
 *   account lock/unlock   → USER_MGMT
 *   repeated auth failure → ANOM_LOGIN_FAILURES
 *   group add             → ADD_GROUP
 *   service start/stop    → SERVICE_START / SERVICE_STOP
 *
 * Mirrors the other reactive projections: the managers announce, this
 * projection keeps the audit trail coherent as a side-effect of the stream.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { LinuxAuditLog } from './LinuxAuditLog';
import type {
  UserCreatedPayload,
  UserDeletedPayload,
  UserPasswordChangedPayload,
  UserLockStateChangedPayload,
  UserLockedOutPayload,
  GroupCreatedPayload,
} from '../iam/events';
import type { ServiceLifecyclePayload } from '../events';

export class AuditTrailProjection {
  private readonly subscriptions: Unsubscribe[] = [];

  constructor(
    bus: IEventBus,
    private readonly auditLog: LinuxAuditLog,
    private readonly deviceId: string,
  ) {
    this.subscriptions.push(
      bus.subscribe('linux.iam.user.created', (e) => this.onUserCreated(e.payload)),
      bus.subscribe('linux.iam.user.deleted', (e) => this.onUserDeleted(e.payload)),
      bus.subscribe('linux.iam.user.password-changed', (e) => this.onPasswordChanged(e.payload)),
      bus.subscribe('linux.iam.user.lock-state-changed', (e) => this.onLockStateChanged(e.payload)),
      bus.subscribe('linux.iam.user.locked-out', (e) => this.onLockedOut(e.payload)),
      bus.subscribe('linux.iam.group.created', (e) => this.onGroupCreated(e.payload)),
      bus.subscribe('linux.service.started', (e) => this.onService(e.payload, 'SERVICE_START')),
      bus.subscribe('linux.service.stopped', (e) => this.onService(e.payload, 'SERVICE_STOP')),
    );
  }

  /** Detach every subscription — call before discarding the projection. */
  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
  }

  // ─── Handlers ──────────────────────────────────────────────────────────

  private onUserCreated(p: UserCreatedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.auditLog.record('ADD_USER', {
      pid: 0, uid: 0, auid: 0, ses: 1,
      msg: `op=add-user id=${p.uid} exe="/usr/sbin/useradd"`,
      acct: p.username, res: 'success',
    });
  }

  private onUserDeleted(p: UserDeletedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.auditLog.record('DEL_USER', {
      pid: 0, uid: 0, auid: 0, ses: 1,
      msg: `op=delete-user id=${p.uid} exe="/usr/sbin/userdel"`,
      acct: p.username, res: 'success',
    });
  }

  private onPasswordChanged(p: UserPasswordChangedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.auditLog.record('USER_CHAUTHTOK', {
      pid: 0, uid: 0, auid: 0, ses: 1,
      msg: `op=${p.disabled ? 'expire-password' : 'change-password'} id=${p.uid} exe="/usr/bin/passwd"`,
      acct: p.username, res: 'success',
    });
  }

  private onLockStateChanged(p: UserLockStateChangedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.auditLog.record('USER_MGMT', {
      pid: 0, uid: 0, auid: 0, ses: 1,
      msg: `op=${p.locked ? 'lock-account' : 'unlock-account'} id=${p.uid} exe="/usr/sbin/usermod"`,
      acct: p.username, res: 'success',
    });
  }

  private onLockedOut(p: UserLockedOutPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.auditLog.record('ANOM_LOGIN_FAILURES', {
      pid: 0, uid: p.uid, auid: p.uid,
      msg: `op=pam_faillock acct=${p.username} failures=${p.failedAttempts}`,
      acct: p.username, res: 'failed',
    });
  }

  private onGroupCreated(p: GroupCreatedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.auditLog.record('ADD_GROUP', {
      pid: 0, uid: 0, auid: 0, ses: 1,
      msg: `op=add-group id=${p.gid} exe="/usr/sbin/groupadd"`,
      acct: p.groupName, res: 'success',
    });
  }

  private onService(p: ServiceLifecyclePayload, type: 'SERVICE_START' | 'SERVICE_STOP'): void {
    if (p.deviceId !== this.deviceId) return;
    this.auditLog.record(type, {
      pid: p.mainPid ?? 1, uid: 0, auid: 0, ses: 1,
      msg: `unit=${p.name} comm="systemd" exe="/usr/lib/systemd/systemd"`,
      res: 'success',
    });
  }
}
