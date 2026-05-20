/**
 * DBA_POLICIES — VPD (virtual private database) policies.
 *
 * Rows are read live from `OracleCatalog.getRlsPolicies()` — the list
 * is fed by `DBMS_RLS.ADD_POLICY / ADD_GROUPED_POLICY`. The view
 * exposes the columns Oracle 19c carries: the policy function (split
 * into owner / package / function), the four statement-type flags
 * (sel/ins/upd/del/idx), the enablement and policy-type discriminators,
 * the (optional) policy group, and the legacy CHK_OPTION column.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

interface RlsPolicyRow {
  objectOwner: string; objectName: string;
  policyName: string; policyGroup: string;
  pfOwner: string; pfPackage: string | null; pfFunction: string;
  statementTypes: { sel: boolean; ins: boolean; upd: boolean; del: boolean; idx: boolean };
  enabled: boolean;
  policyType: string;
}

registerView({
  name: 'DBA_POLICIES',
  comment: 'VPD policies',
  query({ catalog }) {
    const c = catalog as unknown as { getRlsPolicies?: () => RlsPolicyRow[] };
    const policies = c.getRlsPolicies ? c.getRlsPolicies() : [];
    return queryResult(
      [
        col.str('OBJECT_OWNER', 30),
        col.str('OBJECT_NAME', 30),
        col.str('POLICY_GROUP', 30),
        col.str('POLICY_NAME', 30),
        col.str('PF_OWNER', 30),
        col.str('PACKAGE', 30),
        col.str('FUNCTION', 30),
        col.str('SEL', 3),
        col.str('INS', 3),
        col.str('UPD', 3),
        col.str('DEL', 3),
        col.str('IDX', 3),
        col.str('CHK_OPTION', 3),
        col.str('ENABLE', 3),
        col.str('STATIC_POLICY', 3),
        col.str('POLICY_TYPE', 24),
        col.str('LONG_PREDICATE', 3),
      ],
      policies.map(p => [
        p.objectOwner, p.objectName, p.policyGroup, p.policyName,
        p.pfOwner, p.pfPackage, p.pfFunction,
        p.statementTypes.sel ? 'YES' : 'NO',
        p.statementTypes.ins ? 'YES' : 'NO',
        p.statementTypes.upd ? 'YES' : 'NO',
        p.statementTypes.del ? 'YES' : 'NO',
        p.statementTypes.idx ? 'YES' : 'NO',
        'NO',
        p.enabled ? 'YES' : 'NO',
        p.policyType === 'STATIC' ? 'YES' : 'NO',
        p.policyType,
        'NO',
      ])
    );
  },
});
