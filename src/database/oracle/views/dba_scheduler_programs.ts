/**
 * DBA_SCHEDULER_PROGRAMS — DBMS_SCHEDULER programs.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_SCHEDULER_PROGRAMS',
  comment: 'DBMS_SCHEDULER programs',
  query() {
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('PROGRAM_NAME', 30),
        col.str('PROGRAM_TYPE', 16),
        col.str('PROGRAM_ACTION', 4000),
        col.num('NUMBER_OF_ARGUMENTS'),
        col.str('ENABLED', 5),
      ],
      []
    );
  },
});
