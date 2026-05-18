/**
 * V$CLUSTER_INSTANCE — list of instances in a RAC database.
 *
 * Single-instance simulation: emits exactly one row reflecting the
 * current OracleInstance configuration.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$CLUSTER_INSTANCE',
  comment: 'Cluster database instances',
  query({ instance }) {
    return queryResult(
      [col.num('INSTANCE_NUMBER'), col.str('INSTANCE_NAME', 60)],
      [[1, instance.config.sid]]
    );
  },
});
