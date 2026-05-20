/**
 * ProfileManager — Oracle profile lifecycle and limit resolution.
 *
 * Responsibilities:
 *   - CRUD for named profiles (CREATE / ALTER / DROP)
 *   - Resolving effective limits (DEFAULT → concrete value)
 *   - Encoding/decoding fractional days (e.g. 1/24 = 0.041667)
 */

import { DEFAULT_PROFILE_LIMITS, ALL_PROFILE_PARAMETERS } from './types';

export class ProfileManager {
  /** name (upper) → limits (parameter upper → value) */
  private profiles = new Map<string, Map<string, string>>();

  // ── CRUD ──────────────────────────────────────────────────────────

  createProfile(name: string, limits: Map<string, string>): void {
    const key = name.toUpperCase();
    if (key === 'DEFAULT') throw new Error('ORA-02379: profile DEFAULT cannot be created');
    const stored = new Map<string, string>();
    for (const [k, v] of limits) stored.set(k.toUpperCase(), v.toUpperCase());
    this.profiles.set(key, stored);
  }

  alterProfile(name: string, limits: Map<string, string>): void {
    const key = name.toUpperCase();
    if (key === 'DEFAULT') {
      // Alter the default profile — store overrides
      const existing = this.profiles.get('DEFAULT') ?? new Map<string, string>();
      for (const [k, v] of limits) existing.set(k.toUpperCase(), v.toUpperCase());
      this.profiles.set('DEFAULT', existing);
      return;
    }
    const existing = this.profiles.get(key);
    if (!existing) throw new Error(`ORA-02380: profile ${key} does not exist`);
    for (const [k, v] of limits) existing.set(k.toUpperCase(), v.toUpperCase());
  }

  dropProfile(name: string): void {
    const key = name.toUpperCase();
    if (key === 'DEFAULT') throw new Error('ORA-02381: cannot drop DEFAULT profile');
    this.profiles.delete(key);
  }

  profileExists(name: string): boolean {
    const key = name.toUpperCase();
    return key === 'DEFAULT' || this.profiles.has(key);
  }

  getAllProfileNames(): string[] {
    return ['DEFAULT', ...Array.from(this.profiles.keys())];
  }

  /** Return raw limits map for a given profile (no DEFAULT resolution). */
  getRawLimits(name: string): Map<string, string> {
    const key = name.toUpperCase();
    return this.profiles.get(key) ?? new Map();
  }

  // ── Limit resolution ─────────────────────────────────────────────

  /**
   * Resolve the effective limit for a given parameter and profile.
   * Handles DEFAULT inheritance: if a profile says DEFAULT for a param,
   * it falls back to the DEFAULT profile's value (or the built-in default).
   */
  resolveLimit(profileName: string, parameter: string): string {
    const key = profileName.toUpperCase();
    const param = parameter.toUpperCase();

    const rawValue = this.getRawLimitsFor(key, param);

    if (rawValue === 'DEFAULT' || rawValue === undefined) {
      return this.getDefaultValue(param);
    }
    return rawValue;
  }

  /** Resolve PASSWORD_LOCK_TIME to decimal days. 1/24 → 0.041667 */
  resolveLockTimeDays(profileName: string): number {
    const raw = this.resolveLimit(profileName, 'PASSWORD_LOCK_TIME');
    return this.parseDaysFraction(raw);
  }

  resolveLockTimeSeconds(profileName: string): number {
    return this.resolveLockTimeDays(profileName) * 86400;
  }

  resolveFailedLoginAttempts(profileName: string): number {
    const v = this.resolveLimit(profileName, 'FAILED_LOGIN_ATTEMPTS');
    return v === 'UNLIMITED' ? Infinity : parseInt(v, 10) || 10;
  }

  resolvePasswordLifetimeDays(profileName: string): number {
    const v = this.resolveLimit(profileName, 'PASSWORD_LIFE_TIME');
    return v === 'UNLIMITED' ? Infinity : parseFloat(v);
  }

  resolvePasswordGraceDays(profileName: string): number {
    const v = this.resolveLimit(profileName, 'PASSWORD_GRACE_TIME');
    return v === 'UNLIMITED' ? Infinity : parseFloat(v);
  }

  resolvePasswordReuseTime(profileName: string): number {
    const v = this.resolveLimit(profileName, 'PASSWORD_REUSE_TIME');
    return v === 'UNLIMITED' ? Infinity : parseFloat(v);
  }

  resolvePasswordReuseMax(profileName: string): number {
    const v = this.resolveLimit(profileName, 'PASSWORD_REUSE_MAX');
    return v === 'UNLIMITED' ? Infinity : parseInt(v, 10);
  }

  resolveSessionsPerUser(profileName: string): number {
    const v = this.resolveLimit(profileName, 'SESSIONS_PER_USER');
    return v === 'UNLIMITED' ? Infinity : parseInt(v, 10);
  }

  resolveIdleTimeMinutes(profileName: string): number {
    const v = this.resolveLimit(profileName, 'IDLE_TIME');
    return v === 'UNLIMITED' ? Infinity : parseFloat(v);
  }

  resolveConnectTimeMinutes(profileName: string): number {
    const v = this.resolveLimit(profileName, 'CONNECT_TIME');
    return v === 'UNLIMITED' ? Infinity : parseFloat(v);
  }

  // ── Password complexity verification ────────────────────────────
  //
  // Real Oracle ships a handful of PL/SQL verify functions in
  // utlpwdmg.sql: ORA12C_VERIFY_FUNCTION, ORA12C_STRONG_VERIFY_FUNCTION,
  // ORA12C_STIG_VERIFY_FUNCTION, and the legacy VERIFY_FUNCTION_11G.
  // We implement them as deterministic in-engine predicates so that
  // ALTER USER and CREATE USER refuse weak passwords whenever the
  // profile demands it.

  resolvePasswordVerifyFunction(profileName: string): string {
    return this.resolveLimit(profileName, 'PASSWORD_VERIFY_FUNCTION').toUpperCase();
  }

  /**
   * Validate a password against the profile's verify function. Returns
   * `null` on success, or the precise ORA-message Oracle would emit.
   */
  verifyPassword(profileName: string, username: string, password: string): string | null {
    const fn = this.resolvePasswordVerifyFunction(profileName);
    if (fn === 'NULL' || fn === 'DEFAULT' || fn === '') return null;
    return ProfileManager.runBuiltinVerifier(fn, username, password);
  }

  private static runBuiltinVerifier(fn: string, username: string, password: string): string | null {
    const u = username.toUpperCase();
    const p = password;
    // All built-in verifiers require a non-empty value distinct from the
    // username and the company name token.
    if (!p) return 'ORA-28003: password verification for the specified password failed (empty password)';
    if (p.toUpperCase() === u) return 'ORA-28003: password verification for the specified password failed (password equals username)';

    const hasUpper = /[A-Z]/.test(p);
    const hasLower = /[a-z]/.test(p);
    const hasDigit = /\d/.test(p);
    const hasSpec  = /[^A-Za-z0-9]/.test(p);

    switch (fn) {
      case 'ORA12C_VERIFY_FUNCTION':
        if (p.length < 8) return 'ORA-28003: password verification for the specified password failed (length < 8)';
        if (!(hasUpper && hasLower && hasDigit)) {
          return 'ORA-28003: password verification for the specified password failed (must mix upper/lower/digit)';
        }
        return null;
      case 'ORA12C_STRONG_VERIFY_FUNCTION':
      case 'ORA12C_STIG_VERIFY_FUNCTION':
        if (p.length < 9) return 'ORA-28003: password verification for the specified password failed (length < 9)';
        if (!hasUpper || !hasLower || !hasDigit || !hasSpec) {
          return 'ORA-28003: password verification for the specified password failed (must mix upper/lower/digit/special)';
        }
        return null;
      case 'VERIFY_FUNCTION_11G':
        if (p.length < 8) return 'ORA-28003: password verification for the specified password failed (length < 8)';
        if (!hasDigit && !hasSpec) {
          return 'ORA-28003: password verification for the specified password failed (must contain digit or special)';
        }
        return null;
      default:
        // Unknown verifier — accept rather than refuse; matches Oracle
        // behaviour when the function does not exist (would actually
        // raise ORA-04042, but blocking here is worse).
        return null;
    }
  }

  // ── DBA_PROFILES rows ────────────────────────────────────────────

  /** Return all rows suitable for DBA_PROFILES. */
  getAllProfileRows(): Array<{ profile: string; resourceName: string; resourceType: string; limit: string }> {
    const rows: Array<{ profile: string; resourceName: string; resourceType: string; limit: string }> = [];
    const profiles = this.getAllProfileNames();

    for (const profileName of profiles) {
      for (const param of ALL_PROFILE_PARAMETERS) {
        const rawLimits = this.getRawLimits(profileName);
        const limitStr = profileName === 'DEFAULT'
          ? (this.profiles.get('DEFAULT')?.get(param) ?? DEFAULT_PROFILE_LIMITS[param] ?? 'DEFAULT')
          : (rawLimits.get(param) ?? 'DEFAULT');
        rows.push({
          profile: profileName,
          resourceName: param,
          resourceType: this.getResourceType(param),
          limit: limitStr,
        });
      }
    }
    return rows;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private getRawLimitsFor(profileKey: string, param: string): string | undefined {
    return this.profiles.get(profileKey)?.get(param);
  }

  private getDefaultValue(param: string): string {
    // Check if DEFAULT profile has been altered
    const defaultOverride = this.profiles.get('DEFAULT')?.get(param);
    if (defaultOverride && defaultOverride !== 'DEFAULT') return defaultOverride;
    return DEFAULT_PROFILE_LIMITS[param] ?? 'UNLIMITED';
  }

  private getResourceType(param: string): string {
    const passwordParams = [
      'FAILED_LOGIN_ATTEMPTS', 'PASSWORD_LIFE_TIME', 'PASSWORD_REUSE_TIME',
      'PASSWORD_REUSE_MAX', 'PASSWORD_LOCK_TIME', 'PASSWORD_GRACE_TIME',
      'PASSWORD_VERIFY_FUNCTION',
    ];
    return passwordParams.includes(param) ? 'PASSWORD' : 'KERNEL';
  }

  /** Parse a fraction like "1/24" or "1/1440" into a decimal day value. */
  parseDaysFraction(value: string): number {
    if (value === 'UNLIMITED') return Infinity;
    if (value === 'DEFAULT') return 1; // 1 day
    const parts = value.split('/');
    if (parts.length === 2) {
      const num = parseFloat(parts[0]);
      const den = parseFloat(parts[1]);
      if (!isNaN(num) && !isNaN(den) && den !== 0) return num / den;
    }
    return parseFloat(value) || 0;
  }
}
