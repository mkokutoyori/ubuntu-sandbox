/**
 * IamAuthLogProjection — reactive bridge from IAM domain events to the
 * authentication log.
 *
 * `LinuxUserManager` already publishes deviceId-scoped IAM events on the
 * central `EventBus`. Rather than letting the manager also know how to format
 * log lines, this projection *subscribes* to those events and appends the
 * faithful `useradd` / `userdel` / `passwd` / `usermod` records a real host
 * writes to `/var/log/auth.log`.
 *
 * This keeps the design event-driven and decoupled: the manager mutates and
 * announces; the log stays coherent as a pure side-effect of the stream.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { LinuxLogManager } from '../../LinuxLogManager';
import type {
  UserCreatedPayload,
  UserDeletedPayload,
  UserPasswordChangedPayload,
  UserLockStateChangedPayload,
  GroupCreatedPayload,
  GroupDeletedPayload,
  GroupMembershipChangedPayload,
} from '../events';

export class IamAuthLogProjection {
  private readonly subscriptions: Unsubscribe[] = [];

  constructor(
    bus: IEventBus,
    private readonly logManager: LinuxLogManager,
    private readonly deviceId: string,
  ) {
    this.subscriptions.push(
      bus.subscribe('linux.iam.user.created', (e) => this.onUserCreated(e.payload)),
      bus.subscribe('linux.iam.user.deleted', (e) => this.onUserDeleted(e.payload)),
      bus.subscribe('linux.iam.user.password-changed', (e) => this.onPasswordChanged(e.payload)),
      bus.subscribe('linux.iam.user.lock-state-changed', (e) => this.onLockStateChanged(e.payload)),
      bus.subscribe('linux.iam.group.created', (e) => this.onGroupCreated(e.payload)),
      bus.subscribe('linux.iam.group.deleted', (e) => this.onGroupDeleted(e.payload)),
      bus.subscribe('linux.iam.group.membership-changed', (e) => this.onMembershipChanged(e.payload)),
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
    this.logManager.logAuth(
      'useradd',
      `new user: name=${p.username}, UID=${p.uid}, GID=${p.gid}, ` +
        `home=${p.home}, shell=${p.shell}`,
    );
  }

  private onUserDeleted(p: UserDeletedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logAuth('userdel', `delete user '${p.username}'`);
  }

  private onPasswordChanged(p: UserPasswordChangedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    const verb = p.disabled ? 'password expired for' : 'password changed for';
    this.logManager.logAuth('passwd', `${verb} ${p.username}`);
  }

  private onLockStateChanged(p: UserLockStateChangedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    const verb = p.locked ? 'lock' : 'unlock';
    this.logManager.logAuth('usermod', `${verb} user '${p.username}'`);
  }

  private onGroupCreated(p: GroupCreatedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    // A user-private group is logged under `useradd`, a standalone one under
    // `groupadd` — matching which tool the kernel attributes the entry to.
    const tag = p.userPrivateGroup ? 'useradd' : 'groupadd';
    this.logManager.logAuth(tag, `new group: name=${p.groupName}, GID=${p.gid}`);
  }

  private onGroupDeleted(p: GroupDeletedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logAuth('groupdel', `group '${p.groupName}' removed`);
  }

  private onMembershipChanged(p: GroupMembershipChangedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    const direction = p.action === 'added' ? 'add' : 'remove';
    this.logManager.logAuth(
      'usermod',
      `${direction} '${p.username}' to group '${p.groupName}'`,
    );
  }
}
