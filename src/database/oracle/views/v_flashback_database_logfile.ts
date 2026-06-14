/**
 * V$FLASHBACK_DATABASE_LOGFILE — flashback log files.
 *
 * One row per `oracle.flashback.event { kind: 'logged' }`.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { ORACLE_CONFIG } from '../OracleConfig';

registerView({
  name: 'V$FLASHBACK_DATABASE_LOGFILE',
  comment: 'Flashback log files',
  query({ runtime }) {
    return queryResult(
      [
        col.str('NAME', 513),
        col.num('LOG#'),
        col.num('THREAD#'),
        col.num('BYTES'),
        col.date('FIRST_TIME'),
        col.num('FIRST_CHANGE#'),
      ],
      runtime.flashbackHistory
        .filter(f => f.kind === 'logged')
        .map((f, idx) => [
          `${ORACLE_CONFIG.BASE}/fast_recovery_area/flashback/o1_mf_${idx + 1}.flb`,
          idx + 1, 1, f.bytes,
          new Date(f.ts).toISOString(),
          f.scn,
        ])
    );
  },
});
