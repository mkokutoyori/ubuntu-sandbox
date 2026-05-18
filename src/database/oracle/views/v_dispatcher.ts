/**
 * V$DISPATCHER — shared-server dispatchers.
 *
 * Returns one row per configured dispatcher from the `dispatchers`
 * parameter; empty when shared server is not enabled.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$DISPATCHER',
  comment: 'Shared-server dispatchers',
  query({ instance, runtime }) {
    const cfg = instance.getParameter('dispatchers') ?? '';
    if (!cfg) return queryResult([col.str('NAME', 4), col.str('NETWORK', 32), col.str('STATUS', 8)], []);
    return queryResult(
      [
        col.str('NAME', 4),
        col.str('NETWORK', 32),
        col.str('STATUS', 8),
        col.num('ACCEPT'),
        col.num('MESSAGES'),
        col.num('BYTES'),
        col.num('OWNED'),
        col.num('CREATED'),
        col.num('IDLE'),
        col.num('BUSY'),
        col.num('LISTENER'),
        col.str('CONF_INDX', 4),
      ],
      [['D000', 'TCP', runtime.listenerState === 'running' ? 'WAIT' : 'BREAK', 0, 0, 0, 0, 0, 100, 0, 0, '0']]
    );
  },
});
