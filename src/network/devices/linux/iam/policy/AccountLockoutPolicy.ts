/**
 * AccountLockoutPolicy — model of `/etc/security/faillock.conf`, the policy
 * `pam_faillock` consults to lock an account after repeated failed logins.
 *
 * `LinuxUserAccount` already keeps a `failedLoginCount` tally (the
 * `pam_faillock` equivalent of `/var/run/faillock/<user>`). This class is the
 * *rule* applied to that tally: how many failures trip the lock, how long the
 * lock lasts, and whether root is exempt.
 *
 * Every key a real `faillock.conf` carries is modelled — including the ones
 * the simulator does not consume yet (`failInterval`, `auditEnabled`) — so a
 * later time-windowed lockout or audit-trail enhancement is a pure addition.
 */

export interface AccountLockoutPolicyInit {
  /** `deny` — consecutive failures that trip the lock (0 = lockout disabled). */
  deny?: number;
  /** `fail_interval` — seconds within which failures are counted together. */
  failInterval?: number;
  /** `unlock_time` — seconds before a locked account auto-unlocks (0 = never). */
  unlockTime?: number;
  /** `root_unlock_time` — auto-unlock delay for uid 0. */
  rootUnlockTime?: number;
  /** `even_deny_root` — apply the lockout to root as well. */
  evenDenyRoot?: boolean;
  /** `audit` — log the offending user name on each failure. */
  auditEnabled?: boolean;
  /** `silent` — suppress the informational messages on a denied login. */
  silent?: boolean;
  /** `local_users_only` — only track accounts present in `/etc/passwd`. */
  localUsersOnly?: boolean;
  /** `dir` — directory where the per-user tally files live. */
  tallyDir?: string;
}

export class AccountLockoutPolicy {
  deny: number;
  failInterval: number;
  unlockTime: number;
  rootUnlockTime: number;
  evenDenyRoot: boolean;
  auditEnabled: boolean;
  silent: boolean;
  localUsersOnly: boolean;
  tallyDir: string;

  constructor(init: AccountLockoutPolicyInit = {}) {
    this.deny = init.deny ?? 3;
    this.failInterval = init.failInterval ?? 900;
    this.unlockTime = init.unlockTime ?? 600;
    this.rootUnlockTime = init.rootUnlockTime ?? 0;
    this.evenDenyRoot = init.evenDenyRoot ?? false;
    this.auditEnabled = init.auditEnabled ?? true;
    this.silent = init.silent ?? false;
    this.localUsersOnly = init.localUsersOnly ?? false;
    this.tallyDir = init.tallyDir ?? '/var/run/faillock';
  }

  /** Stock Debian/Ubuntu faillock policy. */
  static defaults(): AccountLockoutPolicy {
    return new AccountLockoutPolicy();
  }

  /** Apply a partial set of overrides, returning the names of changed fields. */
  apply(changes: AccountLockoutPolicyInit): string[] {
    const changed: string[] = [];
    const set = <K extends keyof AccountLockoutPolicy>(key: K, value: AccountLockoutPolicy[K] | undefined) => {
      if (value !== undefined && this[key] !== value) {
        this[key] = value as this[K];
        changed.push(String(key));
      }
    };
    set('deny', changes.deny);
    set('failInterval', changes.failInterval);
    set('unlockTime', changes.unlockTime);
    set('rootUnlockTime', changes.rootUnlockTime);
    set('evenDenyRoot', changes.evenDenyRoot);
    set('auditEnabled', changes.auditEnabled);
    set('silent', changes.silent);
    set('localUsersOnly', changes.localUsersOnly);
    return changed;
  }

  /** True when lockout is configured at all (`deny > 0`). */
  get enabled(): boolean {
    return this.deny > 0;
  }

  /**
   * Whether an account with `failedAttempts` consecutive failures should now
   * be denied. `isRoot` callers are exempt unless `even_deny_root` is set.
   *
   * `lastFailureAt` (ms epoch) + `unlock_time`/`root_unlock_time` (seconds)
   * auto-clear the lock once enough wall-clock time has passed, matching
   * real `pam_faillock` — a value of 0 means the lock never auto-clears
   * (only `faillock --reset` does), same as real faillock.conf semantics.
   */
  shouldLockOut(failedAttempts: number, isRoot = false, lastFailureAt?: number | null, now: number = Date.now()): boolean {
    if (!this.enabled) return false;
    if (isRoot && !this.evenDenyRoot) return false;
    if (failedAttempts < this.deny) return false;
    const unlockAfter = isRoot ? this.rootUnlockTime : this.unlockTime;
    if (unlockAfter > 0 && lastFailureAt != null && now - lastFailureAt >= unlockAfter * 1000) return false;
    return true;
  }

  /** Failures remaining before the next one trips the lock (never negative). */
  attemptsRemaining(failedAttempts: number): number {
    if (!this.enabled) return Infinity;
    return Math.max(0, this.deny - failedAttempts);
  }

  /** Render the canonical `/etc/security/faillock.conf` file content. */
  render(): string {
    const lines = [
      '# Configuration for locking the user after multiple failed',
      '# authentication attempts. Kept coherent by the simulator IAM layer.',
      '',
      `dir = ${this.tallyDir}`,
      this.auditEnabled ? 'audit' : '# audit',
      this.silent ? 'silent' : '# silent',
      this.localUsersOnly ? 'local_users_only' : '# local_users_only',
      `deny = ${this.deny}`,
      `fail_interval = ${this.failInterval}`,
      `unlock_time = ${this.unlockTime}`,
      this.evenDenyRoot ? 'even_deny_root' : '# even_deny_root',
      `root_unlock_time = ${this.rootUnlockTime}`,
      '',
    ];
    return lines.join('\n');
  }
}
