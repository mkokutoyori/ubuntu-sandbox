/**
 * DBA_ADVISOR_ACTIONS — advisor recommended actions.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_ADVISOR_ACTIONS',
  comment: 'Advisor recommended actions',
  query() {
    return queryResult(
      [
        col.str('OWNER', 30),
        col.num('TASK_ID'),
        col.num('REC_ID'),
        col.num('ACTION_ID'),
        col.str('COMMAND', 32),
        col.str('MESSAGE', 500),
      ],
      []
    );
  },
});
