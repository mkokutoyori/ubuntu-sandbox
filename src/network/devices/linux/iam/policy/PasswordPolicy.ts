/**
 * PasswordPolicy — aggregate root for a host's complete password posture.
 *
 * A real Debian/Ubuntu host spreads its password rules across three files:
 *   - `/etc/security/pwquality.conf` — strength rules     → {@link PasswordQualityPolicy}
 *   - `/etc/login.defs`              — aging defaults     → {@link PasswordAgingPolicy}
 *   - `/etc/security/faillock.conf`  — lockout rules      → {@link AccountLockoutPolicy}
 *
 * This aggregate is the single object the IAM layer holds and the single
 * thing consumers subscribe around. It owns the three sub-policies, exposes
 * intention-revealing mutators that report which {@link PasswordPolicySection}
 * changed, and never lets a caller reach in and replace a sub-policy wholesale
 * (encapsulation — invariants stay local).
 */

import { PasswordQualityPolicy, type PasswordQualityPolicyInit } from './PasswordQualityPolicy';
import { PasswordAgingPolicy, type PasswordAgingPolicyInit } from './PasswordAgingPolicy';
import { AccountLockoutPolicy, type AccountLockoutPolicyInit } from './AccountLockoutPolicy';

/** The three independently-configurable sections of a password policy. */
export type PasswordPolicySection = 'quality' | 'aging' | 'lockout';

/** The outcome of mutating a section: what changed, for event publication. */
export interface PolicyChange {
  section: PasswordPolicySection;
  changedFields: string[];
}

export class PasswordPolicy {
  private readonly _quality: PasswordQualityPolicy;
  private _aging: PasswordAgingPolicy;
  private readonly _lockout: AccountLockoutPolicy;

  constructor(
    quality: PasswordQualityPolicy = PasswordQualityPolicy.defaults(),
    aging: PasswordAgingPolicy = PasswordAgingPolicy.defaults(),
    lockout: AccountLockoutPolicy = AccountLockoutPolicy.defaults(),
  ) {
    this._quality = quality;
    this._aging = aging;
    this._lockout = lockout;
  }

  /** Stock Debian/Ubuntu password posture. */
  static defaults(): PasswordPolicy {
    return new PasswordPolicy();
  }

  // ─── Read access ───────────────────────────────────────────────────────

  get quality(): PasswordQualityPolicy {
    return this._quality;
  }

  get aging(): PasswordAgingPolicy {
    return this._aging;
  }

  get lockout(): AccountLockoutPolicy {
    return this._lockout;
  }

  // ─── Section mutators (each reports its change) ─────────────────────────

  /** Apply strength-rule overrides. Returns the change, or null if a no-op. */
  configureQuality(changes: PasswordQualityPolicyInit): PolicyChange | null {
    const changedFields = this._quality.apply(changes);
    return changedFields.length > 0 ? { section: 'quality', changedFields } : null;
  }

  /** Apply aging-default overrides. Returns the change, or null if a no-op. */
  configureAging(changes: PasswordAgingPolicyInit): PolicyChange | null {
    const next = this._aging.withChanges(changes);
    const changedFields = next.diff(this._aging);
    if (changedFields.length === 0) return null;
    this._aging = next;
    return { section: 'aging', changedFields };
  }

  /** Apply lockout-rule overrides. Returns the change, or null if a no-op. */
  configureLockout(changes: AccountLockoutPolicyInit): PolicyChange | null {
    const changedFields = this._lockout.apply(changes);
    return changedFields.length > 0 ? { section: 'lockout', changedFields } : null;
  }
}
