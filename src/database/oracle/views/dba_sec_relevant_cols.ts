/**
 * DBA_SEC_RELEVANT_COLS — columns that activate a VPD policy. Real
 * Oracle emits one row per policy/column pair declared with the
 * `sec_relevant_cols` argument of `DBMS_RLS.ADD_POLICY`.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

interface RlsPolicy {
  objectOwner: string; objectName: string; policyName: string;
  secRelevantCols: string[];
}

registerView({
  name: 'DBA_SEC_RELEVANT_COLS',
  comment: 'Columns that activate a VPD policy',
  query({ catalog }) {
    const c = catalog as unknown as { getRlsPolicies?: () => RlsPolicy[] };
    const policies = c.getRlsPolicies ? c.getRlsPolicies() : [];
    const rows: string[][] = [];
    for (const p of policies) {
      for (const colName of p.secRelevantCols) {
        rows.push([p.objectOwner, p.objectName, p.policyName, colName, 'NONE']);
      }
    }
    return queryResult(
      [
        col.str('OBJECT_OWNER', 30),
        col.str('OBJECT_NAME', 30),
        col.str('POLICY_NAME', 30),
        col.str('SEC_REL_COLUMN', 30),
        col.str('COLUMN_OPTION', 11),
      ],
      rows
    );
  },
});
