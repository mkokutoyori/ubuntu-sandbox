/**
 * V$THREAD — redo thread status.
 *
 * Bound to the live redo-log groups maintained by OracleInstance.
 * Switches between groups are driven by oracle.instance.redo-log-switched
 * events; this view reads the current state at query time.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$THREAD',
  comment: 'Redo thread information',
  query({ instance }) {
    const groups = instance.getRedoLogGroups();
    const current = groups.find(g => g.status === 'CURRENT') ?? groups[0];
    return queryResult(
      [
        col.num('THREAD#'),
        col.str('STATUS', 6),
        col.str('ENABLED', 8),
        col.num('GROUPS'),
        col.num('INSTANCE'),
        col.num('OPEN_TIME'),
        col.num('CURRENT_GROUP#'),
        col.num('SEQUENCE#'),
        col.str('INSTANCE_NAME', 30),
      ],
      [[
        1,
        instance.state === 'OPEN' ? 'OPEN' : 'CLOSED',
        'PUBLIC',
        groups.length,
        1,
        instance.startupTime ? instance.startupTime.getTime() : 0,
        current.group,
        current.sequence,
        instance.config.sid,
      ]]
    );
  },
});
