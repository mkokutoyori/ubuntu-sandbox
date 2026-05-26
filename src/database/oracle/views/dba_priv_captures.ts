/**
 * DBA_PRIV_CAPTURES — capture jobs created via DBMS_PRIVILEGE_CAPTURE.
 *
 * The simulator always runs the implicit always-on capture
 * `ORA_$DEPENDENCY` (same name Oracle uses) so DBA_USED_* / DBA_UNUSED_*
 * always have something to project.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_PRIV_CAPTURES',
  comment: 'Privilege capture jobs',
  query({ instance }) {
    const startedAt = instance.startupTime ?? new Date();
    return queryResult(
      [
        col.str('NAME', 128),
        col.str('ROLES', 4000),
        col.str('CONTEXT', 4000),
        col.str('TYPE', 16),
        col.str('ENABLED', 3),
        col.date('RUN_NAME_START_TIMESTAMP'),
        col.date('RUN_NAME_END_TIMESTAMP'),
      ],
      [['ORA_$DEPENDENCY', null, null, 'DATABASE', 'YES', startedAt.toISOString(), null]],
    );
  },
});
