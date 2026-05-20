/**
 * AUDIT_UNIFIED_POLICIES — one row per (policy, audit-condition) tuple.
 * Real Oracle emits one row per action declared in the policy; we follow
 * that shape so monitoring scripts that group by AUDIT_OPTION see the
 * same cardinality as on a real database.
 *
 * The data is read live from `OracleCatalog.getUnifiedAuditPolicies()` —
 * the rows the user has registered via `CREATE AUDIT POLICY`. Nothing
 * is hard-coded; an empty result here means no policy is registered.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'AUDIT_UNIFIED_POLICIES',
  comment: 'Unified audit policies',
  query({ catalog }) {
    const c = catalog as unknown as { getUnifiedAuditPolicies?: () => {
      name: string; actions: string[]; objectSchema?: string; objectName?: string;
      roles: string[];
    }[] };
    const policies = c.getUnifiedAuditPolicies ? c.getUnifiedAuditPolicies() : [];
    const rows: (string | number | null)[][] = [];
    for (const p of policies) {
      const actions = p.actions.length > 0 ? p.actions : ['ALL'];
      for (const action of actions) {
        rows.push([
          p.name,
          'STANDARD ACTION',
          action,
          p.objectSchema ?? null,
          p.objectName ?? null,
          'NONE',
          null,                                   // CONDITION
          'NONE',                                 // CONDITION_EVAL_OPT
        ]);
      }
      for (const role of p.roles) {
        rows.push([p.name, 'ROLE', role, null, null, 'NONE', null, 'NONE']);
      }
    }
    return queryResult(
      [
        col.str('POLICY_NAME', 128),
        col.str('AUDIT_CONDITION', 30),
        col.str('AUDIT_OPTION', 128),
        col.str('OBJECT_SCHEMA', 128),
        col.str('OBJECT_NAME', 128),
        col.str('OBJECT_TYPE', 30),
        col.str('CONDITION_EVAL_OPT', 4000),
        col.str('AUDIT_OPTION_TYPE', 30),
      ],
      rows
    );
  },
});
