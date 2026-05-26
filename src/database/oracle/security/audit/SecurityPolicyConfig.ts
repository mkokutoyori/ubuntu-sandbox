/**
 * SecurityPolicyConfig — knobs the anomaly detector and the dormant
 * analyzer consult. Defaults match the simulator's demo intent.
 *
 * All durations are in milliseconds unless stated otherwise.
 */

export interface BusinessHoursPolicy {
  /** Start hour [0-23], inclusive. */
  readonly start: number;
  /** End hour [0-23], exclusive. */
  readonly end: number;
  /** Days of week considered business days (0 = Sunday … 6 = Saturday). */
  readonly daysOfWeek: ReadonlySet<number>;
}

export interface SecurityPolicyConfig {
  readonly businessHours: BusinessHoursPolicy;
  /** Minimum DML rows affecting a single table that triggers MASS_DELETE / MASS_SELECT. */
  readonly massActionRowThreshold: number;
  /** Failed-logon count in a sliding window before BRUTE_FORCE is raised. */
  readonly bruteForceThreshold: number;
  /** Sliding-window width for brute-force detection (ms). */
  readonly bruteForceWindowMs: number;
  /** Days of inactivity before an account is reported dormant. */
  readonly dormantThresholdDays: number;
  /** Username allow-list — never flagged dormant (internal accounts). */
  readonly dormantExempt: ReadonlySet<string>;
  /** Periodicity (ms) used by the dormant sweep. */
  readonly dormantSweepIntervalMs: number;
  /** SoD scan periodicity (ms). */
  readonly sodScanIntervalMs: number;
}

export const DEFAULT_BUSINESS_HOURS: BusinessHoursPolicy = Object.freeze({
  start: 7,
  end: 19,
  daysOfWeek: new Set([1, 2, 3, 4, 5]),
});

export const DEFAULT_SECURITY_POLICY: SecurityPolicyConfig = Object.freeze({
  businessHours: DEFAULT_BUSINESS_HOURS,
  massActionRowThreshold: 1000,
  bruteForceThreshold: 5,
  bruteForceWindowMs: 5 * 60 * 1000,
  dormantThresholdDays: 90,
  dormantExempt: new Set(['SYS', 'SYSTEM', 'PUBLIC', 'DBSNMP', 'XS$NULL']),
  dormantSweepIntervalMs: 60 * 60 * 1000,
  sodScanIntervalMs: 60 * 60 * 1000,
});

/** Returns true when the given timestamp is outside business hours. */
export function isOffHours(at: Date, policy: BusinessHoursPolicy = DEFAULT_BUSINESS_HOURS): boolean {
  const day = at.getDay();
  if (!policy.daysOfWeek.has(day)) return true;
  const hour = at.getHours();
  return hour < policy.start || hour >= policy.end;
}
