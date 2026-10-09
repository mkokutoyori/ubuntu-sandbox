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
import { AUDIT_UNSET, acctMessageFields, userMessageFields, type AuditSender, type AcctMessage } from './AuditUserMessage';
import type {
  UserCreatedPayload,
  UserModifiedPayload,
  UserDeletedPayload,
  UserPasswordChangedPayload,
  UserLockStateChangedPayload,
  GroupCreatedPayload,
  GroupDeletedPayload,
} from '../iam/events';
import type { ServiceLifecyclePayload } from '../events';

export class AuditTrailProjection {
  private readonly subscriptions: Unsubscribe[] = [];

  constructor(
    bus: IEventBus,
    private readonly auditLog: LinuxAuditLog,
    private readonly deviceId: string,
    private readonly sender: () => AuditSender = () => ({ pid: 1, uid: 0, auid: AUDIT_UNSET, ses: AUDIT_UNSET }),
  ) {
    this.subscriptions.push(
      bus.subscribe('linux.iam.user.created', (e) => this.onUserCreated(e.payload)),
      bus.subscribe('linux.iam.user.deleted', (e) => this.onUserDeleted(e.payload)),
      bus.subscribe('linux.iam.user.password-changed', (e) => this.onPasswordChanged(e.payload)),
      bus.subscribe('linux.iam.user.lock-state-changed', (e) => this.onLockStateChanged(e.payload)),
      bus.subscribe('linux.iam.user.modified', (e) => this.onUserModified(e.payload)),
      bus.subscribe('linux.iam.group.created', (e) => this.onGroupCreated(e.payload)),
      bus.subscribe('linux.iam.group.deleted', (e) => this.onGroupDeleted(e.payload)),
      bus.subscribe('linux.service.started', (e) => this.onService(e.payload, 'SERVICE_START')),
      bus.subscribe('linux.service.stopped', (e) => this.onService(e.payload, 'SERVICE_STOP')),
    );
  }

  /** Detach every subscription — call before discarding the projection. */
  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
  }

  private account(type: string, message: Omit<AcctMessage, 'tty' | 'success'>, ttyOverride?: string, success = true): void {
    this.auditLog.record(type, acctMessageFields(this.sender(), { ...message, tty: ttyOverride ?? 'pts/0', success }));
  }

  private onUserCreated(p: UserCreatedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.account('ADD_USER', { op: 'adding user', name: null, id: p.uid, exe: '/usr/sbin/useradd' });
    if (p.supplementaryGroups.length > 0) {
      this.account('ADD_USER', { op: 'adding user to group', name: p.username, id: null, exe: '/usr/sbin/useradd' });
      this.account('ADD_USER', { op: 'adding user to shadow group', name: p.username, id: null, exe: '/usr/sbin/useradd' });
    }
    if (p.homeCreated) this.account('ADD_USER', { op: 'adding home directory', name: null, id: p.uid, exe: '/usr/sbin/useradd' });
  }

  private onUserDeleted(p: UserDeletedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.account('DEL_USER', { op: 'deleting user entries', name: null, id: p.uid, exe: '/usr/sbin/userdel' });
    if (p.memberOf.length > 0) this.account('DEL_USER', { op: 'deleting user from group', name: null, id: p.uid, exe: '/usr/sbin/userdel' });
    if (p.privateGroupRemoved) {
      this.account('DEL_GROUP', { op: 'deleting group', name: p.username, id: null, exe: '/usr/sbin/userdel' });
      this.account('DEL_GROUP', { op: 'deleting shadow group', name: p.username, id: null, exe: '/usr/sbin/userdel' });
    }
    if (p.memberOf.length > 0) this.account('DEL_USER', { op: 'deleting user from shadow group', name: null, id: p.uid, exe: '/usr/sbin/userdel' });
    if (p.homeRemoved) this.account('DEL_USER', { op: 'deleting home directory', name: null, id: p.uid, exe: '/usr/sbin/userdel' });
  }

  private onPasswordChanged(p: UserPasswordChangedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.account('USER_CHAUTHTOK', { op: 'PAM:chauthtok grantors=pam_unix', name: p.username, id: null, exe: '/usr/bin/passwd' }, '/dev/pts/0');
  }

  private onLockStateChanged(p: UserLockStateChangedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.account('USER_CHAUTHTOK', { op: p.locked ? 'updating passwd' : 'updating password', name: null, id: p.uid, exe: '/usr/sbin/usermod' }, undefined, false);
  }

  private onUserModified(p: UserModifiedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    const operations: Record<string, string> = { shell: 'changing user shell', home: 'changing home directory' };
    for (const field of p.changedFields) {
      const op = operations[field];
      if (op !== undefined) this.account('USER_CHAUTHTOK', { op, name: null, id: p.uid, exe: '/usr/sbin/usermod' });
    }
  }

  private onGroupDeleted(p: GroupDeletedPayload): void {
    if (p.deviceId !== this.deviceId || p.userPrivateGroup) return;
    for (const op of ['removing group from /etc/group', 'removing group from /etc/gshadow', '']) {
      this.account('DEL_GROUP', { op, name: null, id: p.gid, exe: '/usr/sbin/groupdel' });
    }
  }

  private onGroupCreated(p: GroupCreatedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    if (p.userPrivateGroup) {
      this.account('ADD_GROUP', { op: 'adding group', name: p.groupName, id: null, exe: '/usr/sbin/useradd' });
      return;
    }
    for (const op of ['adding group to /etc/group', 'adding group to /etc/gshadow', '']) {
      this.account('ADD_GROUP', { op, name: null, id: p.gid, exe: '/usr/sbin/groupadd' });
    }
  }

  private onService(p: ServiceLifecyclePayload, type: 'SERVICE_START' | 'SERVICE_STOP'): void {
    if (p.deviceId !== this.deviceId) return;
    const body = `unit=${p.name.replace(/\.service$/, '')} comm="systemd" exe="/usr/lib/systemd/systemd" hostname=? addr=? terminal=? res=success`;
    this.auditLog.record(type, userMessageFields({ pid: 1, uid: 0, auid: AUDIT_UNSET, ses: AUDIT_UNSET }, body));
  }
}
