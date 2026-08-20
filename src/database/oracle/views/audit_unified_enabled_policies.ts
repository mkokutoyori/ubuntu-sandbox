/**
 * AUDIT_UNIFIED_ENABLED_POLICIES — which unified audit policy is armed,
 * and for whom.
 *
 * `AUDIT POLICY p BY alice` was previously write-only: the enablement was
 * recorded and nothing could read it back. Real Oracle emits one row per
 * (policy, entity) pair; a policy enabled for everyone shows the single
 * entity `ALL USERS`.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'AUDIT_UNIFIED_ENABLED_POLICIES',
  comment: 'Enabled unified audit policies',
  query({ catalog }) {
    const c = catalog as unknown as {
      getEnabledUnifiedAuditPolicies?: () =>
        { policyName: string; entityName: string; entityType: string }[];
    };
    const rows = (c.getEnabledUnifiedAuditPolicies?.() ?? []).map(r => [
      r.policyName, r.entityName, r.entityType, 'BY', 'NO',
    ]);
    return queryResult(
      [
        col.str('POLICY_NAME', 128),
        col.str('ENTITY_NAME', 128),
        col.str('ENTITY_TYPE', 14),
        col.str('ENABLED_OPTION', 14),
        col.str('SUCCESS', 3),
      ],
      rows,
    );
  },
});
