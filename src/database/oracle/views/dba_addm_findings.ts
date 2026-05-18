/**
 * DBA_ADDM_FINDINGS — ADDM findings. Empty unless ADDM tasks have run.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_ADDM_FINDINGS',
  comment: 'ADDM findings',
  query() {
    return queryResult(
      [
        col.num('TASK_ID'),
        col.str('TASK_NAME', 128),
        col.num('FINDING_ID'),
        col.str('TYPE', 11),
        col.str('FINDING_NAME', 4000),
        col.num('IMPACT'),
        col.str('IMPACT_TYPE', 11),
      ],
      []
    );
  },
});
