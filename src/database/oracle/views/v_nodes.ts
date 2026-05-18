/**
 * V$NODES — RAC node list.
 *
 * Single-instance: one node — localhost.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$NODES',
  comment: 'Cluster nodes',
  query() {
    return queryResult(
      [col.num('NODE_NUMBER'), col.str('NODE_NAME', 60)],
      [[1, 'localhost']]
    );
  },
});
