/**
 * Linux IAM — reactive event taxonomy for accounts & groups.
 *
 * Every mutation `LinuxUserManager` performs (`useradd`, `usermod`, `passwd`,
 * `groupadd`, …) publishes a deviceId-scoped domain event on the central
 * `EventBus`. Topics are deviceId-scoped so several Linux hosts sharing one
 * bus never collide.
 *
 * Design intent (mirrors the process/service taxonomy): payloads are plain
 * serialisable records and deliberately carry more context than today's
 * callers consume — `uid`, `systemAccount`, `kind`… — because an account
 * inspector panel, a security audit log, or a "user created" toast are all
 * natural next consumers of this stream.
 *
 * Events are emitted *alongside* the existing return-string API, never
 * replacing it, so current call sites keep working untouched.
 */

import type { AccountKind } from './LinuxUserAccount';

// ─── Identity ───────────────────────────────────────────────────────────

export interface LinuxIamDeviceRef {
  deviceId: string;
}

export interface UserRef extends LinuxIamDeviceRef {
  username: string;
  uid: number;
}

export interface GroupRef extends LinuxIamDeviceRef {
  groupName: string;
  gid: number;
}

// ─── Account lifecycle ──────────────────────────────────────────────────

export interface UserCreatedPayload extends UserRef {
  gid: number;
  home: string;
  shell: string;
  kind: AccountKind;
  /** Supplementary groups the account joined on creation. */
  supplementaryGroups: string[];
  /** True when `useradd` auto-created a user-private group. */
  userPrivateGroupCreated: boolean;
}

export interface UserDeletedPayload extends UserRef {
  /** Whether the home directory was removed (`userdel -r`). */
  homeRemoved: boolean;
}

/** A field-level change on an existing account (`usermod`, `chage`, `chfn`). */
export interface UserModifiedPayload extends UserRef {
  /** Names of the attributes that changed (e.g. `['shell','home']`). */
  changedFields: string[];
}

export interface UserPasswordChangedPayload extends UserRef {
  /** True when the change was a removal / disable rather than a new secret. */
  disabled: boolean;
}

export interface UserLockStateChangedPayload extends UserRef {
  locked: boolean;
}

export interface UserGecosChangedPayload extends UserRef {
  gecos: string;
}

/**
 * A change to one account's password-aging record (`chage`). Carries the full
 * post-change shadow aging fields so a consumer never has to read them back.
 */
export interface UserAgingChangedPayload extends UserRef {
  /** Names of the aging attributes that changed (e.g. `['maxDays','warnDays']`). */
  changedFields: string[];
  lastChange: number;
  minDays: number;
  maxDays: number;
  warnDays: number;
  inactiveDays: number;
  expireDate: number;
}

/** An account tripped the faillock lockout threshold. */
export interface UserLockedOutPayload extends UserRef {
  /** Consecutive failed authentications recorded. */
  failedAttempts: number;
  /** The `deny` threshold from the lockout policy. */
  deny: number;
}

// ─── Password policy ────────────────────────────────────────────────────

/** Which section of the host password policy a change touched. */
export type PasswordPolicySectionTopic = 'quality' | 'aging' | 'lockout';

/** The host-wide password policy was reconfigured. */
export interface PasswordPolicyChangedPayload extends LinuxIamDeviceRef {
  section: PasswordPolicySectionTopic;
  /** Names of the policy fields that changed. */
  changedFields: string[];
}

/** A candidate password failed the quality policy. */
export interface PasswordRejectedPayload extends LinuxIamDeviceRef {
  /** The account the password was being set for. */
  username: string;
  /** The faithful `pam_pwquality` messages describing each violation. */
  reasons: string[];
  /** True when the policy actually blocked the change (vs. warn-only). */
  blocked: boolean;
}

// ─── Group lifecycle ────────────────────────────────────────────────────

export interface GroupCreatedPayload extends GroupRef {
  systemGroup: boolean;
  userPrivateGroup: boolean;
}

export type GroupDeletedPayload = GroupRef;

export interface GroupModifiedPayload extends GroupRef {
  changedFields: string[];
}

export interface GroupMembershipChangedPayload extends GroupRef {
  username: string;
  action: 'added' | 'removed';
}

// ─── Discriminated union ────────────────────────────────────────────────

export type LinuxIamDomainEvent =
  | { topic: 'linux.iam.user.created'; payload: UserCreatedPayload }
  | { topic: 'linux.iam.user.deleted'; payload: UserDeletedPayload }
  | { topic: 'linux.iam.user.modified'; payload: UserModifiedPayload }
  | { topic: 'linux.iam.user.password-changed'; payload: UserPasswordChangedPayload }
  | { topic: 'linux.iam.user.lock-state-changed'; payload: UserLockStateChangedPayload }
  | { topic: 'linux.iam.user.gecos-changed'; payload: UserGecosChangedPayload }
  | { topic: 'linux.iam.user.aging-changed'; payload: UserAgingChangedPayload }
  | { topic: 'linux.iam.user.locked-out'; payload: UserLockedOutPayload }
  | { topic: 'linux.iam.password-policy.changed'; payload: PasswordPolicyChangedPayload }
  | { topic: 'linux.iam.password.rejected'; payload: PasswordRejectedPayload }
  | { topic: 'linux.iam.group.created'; payload: GroupCreatedPayload }
  | { topic: 'linux.iam.group.deleted'; payload: GroupDeletedPayload }
  | { topic: 'linux.iam.group.modified'; payload: GroupModifiedPayload }
  | { topic: 'linux.iam.group.membership-changed'; payload: GroupMembershipChangedPayload };
