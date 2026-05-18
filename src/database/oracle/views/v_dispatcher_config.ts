/**
 * V$DISPATCHER_CONFIG — dispatcher configuration entries.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$DISPATCHER_CONFIG',
  comment: 'Dispatcher configuration',
  query({ instance }) {
    const cfg = instance.getParameter('dispatchers') ?? '';
    return queryResult(
      [
        col.str('CONF_INDX', 4),
        col.str('NETWORK', 64),
        col.num('DISPATCHERS'),
        col.num('CONNECTIONS'),
        col.num('SESSIONS'),
        col.str('SERVICE', 64),
      ],
      cfg ? [['0', 'TCP', 1, 0, 0, instance.config.sid]] : []
    );
  },
});
