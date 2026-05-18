/**
 * DBA_RESUMABLE — currently-suspended resumable sessions.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_RESUMABLE',
  comment: 'Resumable session monitor',
  query() {
    return queryResult(
      [
        col.str('USER_ID', 30),
        col.num('SESSION_ID'),
        col.num('INSTANCE_ID'),
        col.str('STATUS', 9),
        col.num('TIMEOUT'),
        col.date('SUSPEND_TIME'),
        col.date('RESUME_TIME'),
        col.str('NAME', 4000),
        col.str('ERROR_MSG', 4000),
      ],
      []
    );
  },
});
