/**
 * V$LISTENER_NETWORK — listener endpoint table.
 *
 * Listener state is mirrored into runtime by `oracle.listener.event`:
 * START/STOP LISTENER publishes the event in OracleInstance and the
 * runtime actor stores the current state + endpoint. This view returns
 * a single row when the listener is up.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$LISTENER_NETWORK',
  comment: 'Listener endpoints registered with the database',
  query({ runtime }) {
    if (runtime.listenerState !== 'running') {
      return queryResult(
        [col.str('TYPE', 16), col.str('VALUE', 256), col.str('NETWORK', 60)],
        []
      );
    }
    return queryResult(
      [col.str('TYPE', 16), col.str('VALUE', 256), col.str('NETWORK', 60)],
      [
        ['LOCAL LISTENER', runtime.listenerEndpoint, ''],
        ['LISTENER STATUS', 'READY', ''],
      ]
    );
  },
});
