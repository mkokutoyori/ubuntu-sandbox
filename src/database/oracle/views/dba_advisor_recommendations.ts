/**
 * DBA_ADVISOR_RECOMMENDATIONS — advisor recommendations.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_ADVISOR_RECOMMENDATIONS',
  comment: 'Advisor recommendations',
  query() {
    return queryResult(
      [
        col.str('OWNER', 30),
        col.num('TASK_ID'),
        col.num('REC_ID'),
        col.num('FINDING_ID'),
        col.str('TYPE', 30),
        col.num('RANK'),
        col.num('BENEFIT'),
      ],
      []
    );
  },
});
