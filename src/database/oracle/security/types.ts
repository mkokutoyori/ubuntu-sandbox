/**
 * Oracle Security Domain Types
 *
 * Shared interfaces for the security engine: profiles, quotas,
 * login tracking, password management, session limits, and OS context.
 */

// ── Profile ─────────────────────────────────────────────────────────

/** Resolved limit value from a profile (DEFAULT resolved to concrete value). */
export type ProfileLimitValue = 'UNLIMITED' | string; // number as string

/** All recognised Oracle profile resource / password parameters. */
export const ALL_PROFILE_PARAMETERS = [
  // Resource parameters
  'SESSIONS_PER_USER',
  'CPU_PER_SESSION',
  'CPU_PER_CALL',
  'CONNECT_TIME',
  'IDLE_TIME',
  'LOGICAL_READS_PER_SESSION',
  'LOGICAL_READS_PER_CALL',
  'PRIVATE_SGA',
  'COMPOSITE_LIMIT',
  // Password parameters
  'FAILED_LOGIN_ATTEMPTS',
  'PASSWORD_LIFE_TIME',
  'PASSWORD_REUSE_TIME',
  'PASSWORD_REUSE_MAX',
  'PASSWORD_LOCK_TIME',
  'PASSWORD_GRACE_TIME',
  'PASSWORD_VERIFY_FUNCTION',
] as const;

export type ProfileParameter = typeof ALL_PROFILE_PARAMETERS[number];

/** Oracle 19c default profile limits (what 'DEFAULT' resolves to). */
export const DEFAULT_PROFILE_LIMITS: Record<string, string> = {
  SESSIONS_PER_USER: 'UNLIMITED',
  CPU_PER_SESSION: 'UNLIMITED',
  CPU_PER_CALL: 'UNLIMITED',
  CONNECT_TIME: 'UNLIMITED',
  IDLE_TIME: 'UNLIMITED',
  LOGICAL_READS_PER_SESSION: 'UNLIMITED',
  LOGICAL_READS_PER_CALL: 'UNLIMITED',
  PRIVATE_SGA: 'UNLIMITED',
  COMPOSITE_LIMIT: 'UNLIMITED',
  FAILED_LOGIN_ATTEMPTS: '10',
  PASSWORD_LIFE_TIME: '180',
  PASSWORD_REUSE_TIME: 'UNLIMITED',
  PASSWORD_REUSE_MAX: 'UNLIMITED',
  PASSWORD_LOCK_TIME: '1',        // 1 day
  PASSWORD_GRACE_TIME: '7',
  PASSWORD_VERIFY_FUNCTION: 'NULL',
};

// ── Quota ────────────────────────────────────────────────────────────

export interface QuotaRecord {
  username: string;
  tablespace: string;
  /** Used bytes (tracked when objects are created). */
  bytesUsed: number;
  /** -1 = UNLIMITED, 0 = no quota granted. */
  maxBytes: number;
}

// ── Login tracking ───────────────────────────────────────────────────

export interface LoginAttemptRecord {
  failedCount: number;
  lastFailedAt: Date | null;
  /** When the account was auto-locked by failed login enforcement. */
  lockedAt: Date | null;
}

// ── Password history ─────────────────────────────────────────────────

export interface PasswordHistoryRecord {
  /** Plain-text password (simulation — real Oracle stores hashed). */
  password: string;
  changedAt: Date;
}

// ── OS security context ──────────────────────────────────────────────

export interface OsSecurityContext {
  osUser: string;
  osGroup: string;
  /** True when the OS user is in the dba group — permits AS SYSDBA. */
  isDbaGroup: boolean;
  hostname: string;
  terminal: string;
  program: string;
}

export const DEFAULT_OS_CONTEXT: OsSecurityContext = {
  osUser: 'oracle',
  osGroup: 'dba',
  isDbaGroup: true,
  hostname: 'localhost',
  terminal: 'pts/0',
  program: 'sqlplus@localhost',
};
