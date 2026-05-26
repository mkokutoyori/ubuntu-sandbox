/**
 * SodPolicy — Segregation-of-Duties rule.
 *
 * A SoD policy lists privilege / role tokens (e.g. `DBA`, `AUDIT_ADMIN`,
 * `CREATE USER`) that a single principal must not hold simultaneously.
 * Holding any two of the listed tokens triggers a violation.
 *
 * `DEFAULT_SOD_POLICIES` ships the canonical Oracle 19c rules so a
 * fresh database already enforces sensible defaults. DBAs can register
 * their own via `SecurityAuditState.registerSodPolicy(...)`.
 */

import type { ISodPolicy, ISodViolation, Severity } from './interfaces';

export class SodPolicy implements ISodPolicy {
  readonly name: string;
  readonly description: string;
  readonly severity: Severity;
  readonly conflictingPrivileges: string[];
  readonly enabled: boolean;
  readonly createdAt: Date;
  /** Owner of the policy — kept for parity with DV_RULE_SET.OWNER. */
  readonly owner: string;

  constructor(init: {
    name: string; description: string; severity: Severity;
    conflictingPrivileges: string[]; enabled?: boolean; owner?: string;
    createdAt?: Date;
  }) {
    this.name = init.name.toUpperCase();
    this.description = init.description;
    this.severity = init.severity;
    this.conflictingPrivileges = init.conflictingPrivileges.map(p => p.toUpperCase());
    this.enabled = init.enabled ?? true;
    this.owner = (init.owner ?? 'SYS').toUpperCase();
    this.createdAt = init.createdAt ?? new Date();
  }

  /**
   * Evaluate the policy against a user's effective privilege/role set.
   * Returns the subset of `conflictingPrivileges` actually held — empty
   * means no violation, two-or-more means a breach.
   */
  matches(heldTokens: ReadonlySet<string>): string[] {
    if (!this.enabled) return [];
    const matched = this.conflictingPrivileges.filter(p => heldTokens.has(p));
    return matched.length >= 2 ? matched : [];
  }
}

export class SodViolation implements ISodViolation {
  readonly violationId: number;
  readonly timestamp: Date;
  readonly policyName: string;
  readonly username: string;
  readonly sessionId: number;
  readonly conflictingPrivileges: string[];
  readonly severity: Severity;
  readonly description: string;

  constructor(init: {
    violationId: number; policyName: string; username: string;
    sessionId: number; conflictingPrivileges: string[]; severity: Severity;
    description: string; timestamp?: Date;
  }) {
    this.violationId = init.violationId;
    this.timestamp = init.timestamp ?? new Date();
    this.policyName = init.policyName.toUpperCase();
    this.username = init.username.toUpperCase();
    this.sessionId = init.sessionId;
    this.conflictingPrivileges = init.conflictingPrivileges.map(p => p.toUpperCase());
    this.severity = init.severity;
    this.description = init.description;
  }
}

/** Canonical SoD policies for a fresh Oracle 19c install. */
export const DEFAULT_SOD_POLICIES: SodPolicy[] = [
  new SodPolicy({
    name: 'SOD_DBA_AUDITOR',
    description: 'A DBA must not also act as the auditor of the database.',
    severity: 'CRITICAL',
    conflictingPrivileges: ['DBA', 'AUDIT_ADMIN'],
  }),
  new SodPolicy({
    name: 'SOD_USER_MGMT_VS_SECURITY',
    description: 'User-management privileges must not be combined with security policy administration.',
    severity: 'HIGH',
    conflictingPrivileges: ['CREATE USER', 'AUDIT SYSTEM'],
  }),
  new SodPolicy({
    name: 'SOD_DATA_EXFILTRATION',
    description: 'Holding both SELECT ANY TABLE and CREATE ANY DIRECTORY enables silent exfiltration.',
    severity: 'CRITICAL',
    conflictingPrivileges: ['SELECT ANY TABLE', 'CREATE ANY DIRECTORY'],
  }),
  new SodPolicy({
    name: 'SOD_GRANT_MONOPOLY',
    description: 'Combining GRANT ANY PRIVILEGE with GRANT ANY ROLE lets a user escalate themselves.',
    severity: 'CRITICAL',
    conflictingPrivileges: ['GRANT ANY PRIVILEGE', 'GRANT ANY ROLE'],
  }),
  new SodPolicy({
    name: 'SOD_BACKUP_VS_DROP',
    description: 'The backup operator must not be allowed to drop the data they back up.',
    severity: 'HIGH',
    conflictingPrivileges: ['SYSBACKUP', 'DROP ANY TABLE'],
  }),
  new SodPolicy({
    name: 'SOD_DML_VS_AUDIT',
    description: 'A user altering audit configuration must not also perform application DML.',
    severity: 'MEDIUM',
    conflictingPrivileges: ['AUDIT SYSTEM', 'UPDATE ANY TABLE'],
  }),
];
