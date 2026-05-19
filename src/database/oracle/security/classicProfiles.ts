/**
 * Predefined Oracle 19c profiles beyond DEFAULT.
 *
 *   - MONITORING_PROFILE — used by DBSNMP and other monitoring users.
 *     Tighter sessions/idle/CPU limits than DEFAULT.
 *   - ORA_STIG_PROFILE — DISA STIG security baseline (password rules
 *     and account-lockout limits aligned with the STIG).
 *
 * Kept in a dedicated declarative module so OracleDatabase boot stays
 * a single call (`provisionPredefinedProfiles(securityEngine.profiles)`).
 */

import type { ProfileManager } from './ProfileManager';

export interface PredefinedProfile {
  name: string;
  limits: Record<string, string>;
}

export const PREDEFINED_PROFILES: readonly PredefinedProfile[] = [
  {
    name: 'MONITORING_PROFILE',
    limits: {
      SESSIONS_PER_USER: 'UNLIMITED',
      CPU_PER_SESSION: 'UNLIMITED',
      CPU_PER_CALL: 'UNLIMITED',
      CONNECT_TIME: 'UNLIMITED',
      IDLE_TIME: 'UNLIMITED',
      LOGICAL_READS_PER_SESSION: 'UNLIMITED',
      LOGICAL_READS_PER_CALL: 'UNLIMITED',
      PRIVATE_SGA: 'UNLIMITED',
      COMPOSITE_LIMIT: 'UNLIMITED',
      FAILED_LOGIN_ATTEMPTS: 'UNLIMITED',
      PASSWORD_LIFE_TIME: 'UNLIMITED',
      PASSWORD_REUSE_TIME: 'UNLIMITED',
      PASSWORD_REUSE_MAX: 'UNLIMITED',
      PASSWORD_LOCK_TIME: 'UNLIMITED',
      PASSWORD_GRACE_TIME: 'UNLIMITED',
      PASSWORD_VERIFY_FUNCTION: 'NULL',
    },
  },
  {
    name: 'ORA_STIG_PROFILE',
    limits: {
      SESSIONS_PER_USER: 'UNLIMITED',
      CPU_PER_SESSION: 'UNLIMITED',
      CPU_PER_CALL: 'UNLIMITED',
      CONNECT_TIME: 'UNLIMITED',
      IDLE_TIME: '15',
      LOGICAL_READS_PER_SESSION: 'UNLIMITED',
      LOGICAL_READS_PER_CALL: 'UNLIMITED',
      PRIVATE_SGA: 'UNLIMITED',
      COMPOSITE_LIMIT: 'UNLIMITED',
      FAILED_LOGIN_ATTEMPTS: '3',
      PASSWORD_LIFE_TIME: '60',
      PASSWORD_REUSE_TIME: '365',
      PASSWORD_REUSE_MAX: '10',
      PASSWORD_LOCK_TIME: 'UNLIMITED',
      PASSWORD_GRACE_TIME: '5',
      PASSWORD_VERIFY_FUNCTION: 'ORA12C_STIG_VERIFY_FUNCTION',
    },
  },
];

/** Install the predefined profiles. Idempotent. */
export function provisionPredefinedProfiles(profiles: ProfileManager): void {
  for (const p of PREDEFINED_PROFILES) {
    if (profiles.profileExists(p.name)) continue;
    const map = new Map<string, string>();
    for (const [k, v] of Object.entries(p.limits)) map.set(k, v);
    profiles.createProfile(p.name, map);
  }
}
