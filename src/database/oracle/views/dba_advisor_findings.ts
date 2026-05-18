/**
 * DBA_ADVISOR_FINDINGS — advisor framework findings.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_ADVISOR_FINDINGS',
  comment: 'Advisor framework findings',
  query() {
    return queryResult(
      [
        col.str('OWNER', 30),
        col.num('TASK_ID'),
        col.str('TASK_NAME', 128),
        col.num('FINDING_ID'),
        col.num('IMPACT'),
        col.str('MESSAGE', 500),
      ],
      []
    );
  },
});
