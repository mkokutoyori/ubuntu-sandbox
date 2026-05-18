/**
 * V$ACTIVE_INSTANCES — list of currently-active cluster instances.
 *
 * Reactively bound to the OracleInstance: the instance is only listed
 * when its state is OPEN (the state-changed event flips this on/off via
 * the signal store, but the view just reads the live property since the
 * answer is canonical at query time).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$ACTIVE_INSTANCES',
  comment: 'Active cluster instances',
  query({ instance }) {
    if (instance.state !== 'OPEN') {
      return queryResult(
        [col.num('INST_NUMBER'), col.str('INST_NAME', 60)],
        []
      );
    }
    return queryResult(
      [col.num('INST_NUMBER'), col.str('INST_NAME', 60)],
      [[1, `localhost:${instance.config.sid}`]]
    );
  },
});
