/**
 * DBA_TSDP_POLICY_FEATURE — features (DATA_REDACTION, FGA, …) attached
 * to each TSDP policy. Native Oracle 12c+ view.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_TSDP_POLICY_FEATURE',
  comment: 'Features attached to TSDP policies',
  query({ instance }) {
    const reg = instance.getAuditJournal().getSensitiveObjectRegistry();
    const seen = new Set<string>();
    const rows: string[][] = [];
    for (const o of reg.list()) {
      if (seen.has(o.classification)) continue;
      seen.add(o.classification);
      // Each simulated classification is wired to fine-grained auditing
      // by the SecurityAuditActor; report it as the active feature.
      rows.push([`ORA_SIM_${o.classification}`, 'FGA', 'ENABLED']);
    }
    return queryResult(
      [
        col.str('POLICY_NAME', 128),
        col.str('FEATURE_NAME', 30),
        col.str('STATUS', 16),
      ],
      rows,
    );
  },
});
