/**
 * DBA_SCHEDULER_CREDENTIALS — scheduler stored credentials.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_SCHEDULER_CREDENTIALS',
  comment: 'Scheduler credentials',
  query() {
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('CREDENTIAL_NAME', 30),
        col.str('USERNAME', 30),
        col.str('DATABASE_ROLE', 30),
        col.str('ENABLED', 5),
        col.str('COMMENTS', 240),
      ],
      []
    );
  },
});
