import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$RSRC_CONSUMER_GROUP',
  comment: 'Resource Manager consumer group runtime statistics',
  query() {
    return queryResult(
      [
        col.num('ID'),
        col.str('NAME', 32),
        col.num('ACTIVE_SESSIONS'),
        col.num('EXECUTION_WAITERS'),
        col.num('REQUESTS'),
        col.num('CPU_WAIT_TIME'),
        col.num('CPU_WAITS'),
        col.num('CONSUMED_CPU_TIME'),
        col.num('YIELDS'),
        col.num('QUEUE_LENGTH'),
        col.num('CURRENT_UNDO_CONSUMPTION'),
        col.str('CONSUMER_GROUP_ID', 10),
        col.str('CON_ID', 10),
      ],
      [
        [1, 'DEFAULT_CONSUMER_GROUP', 1, 0, 1, 0, 0, 0, 0, 0, 0, '1', '0'],
        [2, 'SYS_GROUP', 1, 0, 1, 0, 0, 0, 0, 0, 0, '2', '0'],
        [3, 'OTHER_GROUPS', 0, 0, 0, 0, 0, 0, 0, 0, 0, '3', '0'],
      ]
    );
  },
});
