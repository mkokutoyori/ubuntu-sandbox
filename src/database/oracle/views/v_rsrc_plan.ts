import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$RSRC_PLAN',
  comment: 'Active Resource Manager plans',
  query() {
    return queryResult(
      [
        col.num('ID'),
        col.str('NAME', 32),
        col.str('IS_TOP_PLAN', 5),
        col.str('CPU_MANAGED', 3),
        col.str('INSTANCE_CAGING', 3),
        col.str('PARALLEL_SERVERS_ACTIVE', 3),
        col.str('PARALLEL_QUEUE_TIMEOUT_ACTIVE', 3),
        col.str('PARALLEL_STMT_CRITICAL_ACTIVE', 3),
        col.str('PGA_LIMIT_ACTIVE', 3),
        col.str('CON_ID', 10),
      ],
      [[1, 'DEFAULT_PLAN', 'TRUE', 'OFF', 'OFF', 'OFF', 'OFF', 'OFF', 'OFF', '0']]
    );
  },
});
