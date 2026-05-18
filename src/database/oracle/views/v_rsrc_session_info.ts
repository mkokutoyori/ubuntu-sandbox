import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$RSRC_SESSION_INFO',
  comment: 'Resource Manager session info',
  query({ runtime }) {
    const rows = [...runtime.sessions.values()]
      .filter(s => s.type === 'USER')
      .map(s => [
        s.sid, 'DEFAULT_CONSUMER_GROUP', 0, 0, 0, 0, 0, 0,
      ]);
    return queryResult(
      [
        col.num('SID'),
        col.str('CURRENT_CONSUMER_GROUP', 32),
        col.num('CPU_WAIT_TIME'),
        col.num('CPU_WAITS'),
        col.num('CONSUMED_CPU_TIME'),
        col.num('QUEUE_TIME'),
        col.num('QUEUE_INSTANCES'),
        col.num('IO_SERVICE_TIME'),
      ],
      rows
    );
  },
});
