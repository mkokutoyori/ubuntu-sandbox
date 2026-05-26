/**
 * DBA_TSDP_POLICY — Transparent Sensitive Data Protection policies.
 *
 * The simulator's SensitiveObjectRegistry materialises one
 * "ORA_SIM_<CLASSIFICATION>" policy per active classification, mirroring
 * how DBMS_TSDP_PROTECT.CREATE_POLICY emits one row per managed policy.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_TSDP_POLICY',
  comment: 'Transparent Sensitive Data Protection policies',
  query({ instance }) {
    const reg = instance.getAuditJournal().getSensitiveObjectRegistry();
    const seen = new Set<string>();
    const rows: string[][] = [];
    for (const o of reg.list()) {
      if (seen.has(o.classification)) continue;
      seen.add(o.classification);
      rows.push([
        `ORA_SIM_${o.classification}`,
        `Auto-generated TSDP policy for ${o.classification} data`,
        'ENABLED',
      ]);
    }
    return queryResult(
      [
        col.str('POLICY_NAME', 128),
        col.str('DESCRIPTION', 4000),
        col.str('STATUS', 16),
      ],
      rows,
    );
  },
});
