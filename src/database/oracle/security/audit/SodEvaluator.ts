/**
 * SodEvaluator — scans the catalog for SoD breaches.
 *
 * Pulls each user's effective privilege/role set from the SecurityEngine
 * privilege checker (recursive role expansion), runs every enabled SoD
 * policy against it, and asks the SecurityAuditActor to journal and
 * publish any matching violations.
 *
 * Scans are triggered (a) on demand from CLI / tests, and (b) by the
 * SecurityAuditActor whenever a `GRANT` or `ALTER USER` DDL crosses the
 * bus — that way the rule is enforced reactively as the privilege
 * graph mutates.
 */

import type { OracleCatalog } from '../../OracleCatalog';
import type { SecurityEngine } from '../SecurityEngine';
import type { AuditJournal } from './AuditJournal';
import type { SecurityAuditActor } from './SecurityAuditActor';
import type { SodPolicy } from './SodPolicy';

export class SodEvaluator {
  constructor(
    private readonly catalog: OracleCatalog,
    private readonly engine: SecurityEngine,
    private readonly journal: AuditJournal,
    private readonly actor: SecurityAuditActor,
  ) {}

  /** Run a full scan over every catalog user. */
  scanAll(): number {
    let found = 0;
    for (const user of this.catalog.getAllUsers()) {
      found += this.scanUser(user.username);
    }
    return found;
  }

  /** Evaluate every enabled policy against a single user. */
  scanUser(username: string, sessionId: number = 0): number {
    const upper = username.toUpperCase();
    const tokens = this.collectTokens(upper);
    let found = 0;
    for (const p of this.journal.getSodPolicies() as readonly SodPolicy[]) {
      const matched = p.matches(tokens);
      if (matched.length >= 2) {
        this.actor.emitSodViolation({
          policyName: p.name, username: upper, sessionId,
          conflictingPrivileges: matched, severity: p.severity,
          description: `${upper} holds ${matched.join(' + ')} — ${p.description}`,
        });
        found++;
      }
    }
    return found;
  }

  /** Effective privilege/role tokens for `username`, recursively. */
  private collectTokens(username: string): Set<string> {
    const tokens = new Set<string>();
    const checker = this.engine.privileges;

    // Direct system privileges
    const cat = this.catalog as unknown as {
      sysPrivileges: { grantee: string; privilege: string }[];
      roleGrants: { grantee: string; role: string }[];
    };
    for (const sp of cat.sysPrivileges) {
      if (sp.grantee === username) tokens.add(sp.privilege.toUpperCase());
    }
    // All recursively granted roles
    for (const role of checker.getGrantedRoles(username)) {
      tokens.add(role.toUpperCase());
      for (const sp of cat.sysPrivileges) {
        if (sp.grantee === role) tokens.add(sp.privilege.toUpperCase());
      }
    }
    return tokens;
  }
}
