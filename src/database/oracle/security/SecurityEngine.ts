/**
 * SecurityEngine — Facade combining all Oracle security subsystems.
 *
 * Coordinates profile enforcement, quota management, login tracking,
 * password lifecycle, and session limits into a unified security layer.
 *
 * This class is the single entry point for all security decisions.
 * Design: Facade + Strategy (each subsystem is independently testable).
 */

import { ProfileManager } from './ProfileManager';
import { QuotaManager } from './QuotaManager';
import { LoginTracker } from './LoginTracker';
import { PasswordManager } from './PasswordManager';
import { SessionLimitTracker, type ActiveSessionInfo } from './SessionLimitTracker';
import { PrivilegeChecker } from './PrivilegeChecker';
import type { OsSecurityContext } from './types';
import { DEFAULT_OS_CONTEXT } from './types';
import type { BaseCatalog } from '../../engine/catalog/BaseCatalog';

export interface AuthenticationResult {
  success: boolean;
  errorCode: number;
  message: string;
  requiresPasswordChange: boolean;
  isGracePeriod: boolean;
}

export interface SessionRegistration {
  sessionId: string;
  info: ActiveSessionInfo;
}

export class SecurityEngine {
  readonly profiles: ProfileManager;
  readonly quotas: QuotaManager;
  readonly loginTracker: LoginTracker;
  readonly passwords: PasswordManager;
  readonly sessions: SessionLimitTracker;
  readonly privileges: PrivilegeChecker;

  constructor(catalog: BaseCatalog) {
    this.profiles = new ProfileManager();
    this.quotas = new QuotaManager();
    this.loginTracker = new LoginTracker();
    this.passwords = new PasswordManager();
    this.sessions = new SessionLimitTracker();
    this.privileges = new PrivilegeChecker(catalog);
  }

  // ── Authentication ────────────────────────────────────────────────

  /**
   * Authenticate a user. Enforces:
   *   - Account status (LOCKED, EXPIRED)
   *   - FAILED_LOGIN_ATTEMPTS / PASSWORD_LOCK_TIME
   *   - PASSWORD_LIFE_TIME / PASSWORD_GRACE_TIME
   */
  authenticate(
    username: string,
    password: string,
    catalog: BaseCatalog,
    storedPassword: string | undefined
  ): AuthenticationResult {
    const upper = username.toUpperCase();
    const user = catalog.getUser(upper);

    if (!user) {
      return { success: false, errorCode: 1017, message: 'ORA-01017: invalid username/password; logon denied', requiresPasswordChange: false, isGracePeriod: false };
    }

    // Check DBA-locked account
    if (user.accountStatus === 'LOCKED') {
      // Check auto-unlock
      const profileName = user.profile;
      const lockTimeDays = this.profiles.resolveLockTimeDays(profileName);
      if (!this.loginTracker.shouldAutoUnlock(upper, lockTimeDays)) {
        return { success: false, errorCode: 28000, message: 'ORA-28000: the account is locked', requiresPasswordChange: false, isGracePeriod: false };
      }
      // Auto-unlock
      catalog.unlockUser(upper);
      this.loginTracker.unlockAccount(upper);
    }

    // Verify password
    if (storedPassword === undefined || storedPassword !== password) {
      this.loginTracker.recordFailure(upper);

      const profileName = user.profile;
      const maxAttempts = this.profiles.resolveFailedLoginAttempts(profileName);

      if (this.loginTracker.exceedsThreshold(upper, maxAttempts)) {
        catalog.lockUser(upper);
        this.loginTracker.lockAccount(upper);
        return { success: false, errorCode: 28000, message: 'ORA-28000: the account is locked', requiresPasswordChange: false, isGracePeriod: false };
      }

      return { success: false, errorCode: 1017, message: 'ORA-01017: invalid username/password; logon denied', requiresPasswordChange: false, isGracePeriod: false };
    }

    // Password correct — check expiry
    const profileName = user.profile;
    const lifetimeDays = this.profiles.resolvePasswordLifetimeDays(profileName);
    const graceDays = this.profiles.resolvePasswordGraceDays(profileName);
    const pwdStatus = this.passwords.getPasswordStatus(upper, lifetimeDays, graceDays);

    if (pwdStatus === 'EXPIRED') {
      return { success: false, errorCode: 28001, message: 'ORA-28001: the password has expired', requiresPasswordChange: true, isGracePeriod: false };
    }

    if (pwdStatus === 'EXPIRED(GRACE)') {
      this.loginTracker.recordSuccess(upper);
      return { success: true, errorCode: 0, message: 'ORA-28002: the password will expire within 7 days', requiresPasswordChange: true, isGracePeriod: true };
    }

    // Force-expired by DBA
    if (this.passwords.isForceExpired(upper)) {
      return { success: false, errorCode: 28001, message: 'ORA-28001: the password has expired', requiresPasswordChange: true, isGracePeriod: false };
    }

    this.loginTracker.recordSuccess(upper);
    return { success: true, errorCode: 0, message: '', requiresPasswordChange: false, isGracePeriod: false };
  }

  // ── Session lifecycle ─────────────────────────────────────────────

  openSession(
    sessionId: string,
    username: string,
    schema: string,
    osCtx: OsSecurityContext = DEFAULT_OS_CONTEXT,
    catalog?: BaseCatalog,
    sid?: number,
    serial?: number,
  ): { ok: boolean; error?: string; info?: ActiveSessionInfo } {
    const upper = username.toUpperCase();

    // Check SESSIONS_PER_USER
    if (catalog) {
      const user = catalog.getUser(upper);
      if (user) {
        const maxSessions = this.profiles.resolveSessionsPerUser(user.profile);
        const current = this.sessions.countUserSessions(upper);
        if (current >= maxSessions) {
          return { ok: false, error: `ORA-02391: exceeded simultaneous SESSIONS_PER_USER limit` };
        }
      }
    }

    const info = this.sessions.registerSession(sessionId, username, schema, osCtx, 'USER', sid, serial);
    return { ok: true, info };
  }

  closeSession(sessionId: string): void {
    this.sessions.unregisterSession(sessionId);
  }

  // ── Password change ───────────────────────────────────────────────

  changePassword(
    username: string,
    newPassword: string,
    profileName: string
  ): { ok: boolean; error?: string } {
    const upper = username.toUpperCase();

    // Complexity check (PASSWORD_VERIFY_FUNCTION) runs first — Oracle
    // refuses to even consider reuse if the verifier rejects the value.
    const verifierError = this.profiles.verifyPassword(profileName, upper, newPassword);
    if (verifierError) {
      return { ok: false, error: verifierError };
    }

    const reuseTime = this.profiles.resolvePasswordReuseTime(profileName);
    const reuseMax = this.profiles.resolvePasswordReuseMax(profileName);

    if (this.passwords.violatesReuseTime(upper, newPassword, reuseTime)) {
      return { ok: false, error: 'ORA-28007: the password cannot be reused' };
    }
    if (this.passwords.violatesReuseMax(upper, newPassword, reuseMax)) {
      return { ok: false, error: 'ORA-28007: the password cannot be reused' };
    }

    this.passwords.setPassword(upper, newPassword);
    return { ok: true };
  }

  /** Standalone verifier check — used by CREATE USER. */
  verifyPasswordForProfile(username: string, password: string, profileName: string): string | null {
    return this.profiles.verifyPassword(profileName, username, password);
  }

  // ── Quota ────────────────────────────────────────────────────────

  applyQuotas(username: string, quotas: Array<{ size: string; tablespace: string }>): void {
    for (const q of quotas) {
      this.quotas.grantQuota(username, q.tablespace, q.size);
    }
  }

  dropUserCleanup(username: string): void {
    this.quotas.dropUserQuotas(username);
    this.loginTracker.dropUser(username);
    this.passwords.dropUser(username);
    this.sessions.killUserSessions(username);
  }
}
