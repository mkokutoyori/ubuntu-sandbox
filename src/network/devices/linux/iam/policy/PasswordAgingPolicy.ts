/**
 * PasswordAgingPolicy — the system-wide password-aging defaults a new account
 * inherits (`PASS_MAX_DAYS`, `PASS_MIN_DAYS`, `PASS_WARN_AGE` in
 * `/etc/login.defs`, plus the inactivity grace from `/etc/default/useradd`).
 *
 * It is an immutable value object: `chage` mutates a *single account's*
 * shadow record, but the policy itself is the template every freshly created
 * account is stamped with. `withChanges()` returns a new instance rather than
 * mutating, so a policy can be safely shared and compared.
 *
 * The shadow time unit is "days since the Unix epoch"; the sentinels match
 * what `/etc/shadow` uses — `99999` days ≈ "never expires", `-1` ≈ "disabled".
 */

/** "Maximum password age" sentinel — shadow's conventional "never". */
export const PASSWORD_NEVER_EXPIRES = 99999;
/** Inactivity / expiry sentinel — shadow's conventional "disabled". */
export const AGING_DISABLED = -1;

export interface PasswordAgingPolicyInit {
  /** `PASS_MAX_DAYS` — days a password stays valid. */
  maxDays?: number;
  /** `PASS_MIN_DAYS` — days that must pass before another change is allowed. */
  minDays?: number;
  /** `PASS_WARN_AGE` — days of warning before expiry. */
  warnDays?: number;
  /** Inactivity grace after expiry before the account is disabled. */
  inactiveDays?: number;
}

export class PasswordAgingPolicy {
  readonly maxDays: number;
  readonly minDays: number;
  readonly warnDays: number;
  readonly inactiveDays: number;

  constructor(init: PasswordAgingPolicyInit = {}) {
    this.maxDays = init.maxDays ?? PASSWORD_NEVER_EXPIRES;
    this.minDays = init.minDays ?? 0;
    this.warnDays = init.warnDays ?? 7;
    this.inactiveDays = init.inactiveDays ?? AGING_DISABLED;
  }

  /** Stock Debian/Ubuntu aging defaults. */
  static defaults(): PasswordAgingPolicy {
    return new PasswordAgingPolicy();
  }

  /** Return a copy with the supplied fields overridden. */
  withChanges(changes: PasswordAgingPolicyInit): PasswordAgingPolicy {
    return new PasswordAgingPolicy({
      maxDays: changes.maxDays ?? this.maxDays,
      minDays: changes.minDays ?? this.minDays,
      warnDays: changes.warnDays ?? this.warnDays,
      inactiveDays: changes.inactiveDays ?? this.inactiveDays,
    });
  }

  /** The field names that differ between this policy and another. */
  diff(other: PasswordAgingPolicy): string[] {
    const changed: string[] = [];
    if (this.maxDays !== other.maxDays) changed.push('maxDays');
    if (this.minDays !== other.minDays) changed.push('minDays');
    if (this.warnDays !== other.warnDays) changed.push('warnDays');
    if (this.inactiveDays !== other.inactiveDays) changed.push('inactiveDays');
    return changed;
  }

  /** True when the policy leaves passwords valid forever. */
  get neverExpires(): boolean {
    return this.maxDays >= PASSWORD_NEVER_EXPIRES || this.maxDays < 0;
  }
}
