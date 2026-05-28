import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_WAITERS',
  comment: 'Sessions waiting on a lock held by another session',
  query({ instance }) {
    return queryResult(
      [
        col.num('WAITING_SESSION'),
        col.num('HOLDING_SESSION'),
        col.str('LOCK_TYPE', 26),
        col.num('MODE_HELD'),
        col.num('MODE_REQUESTED'),
        col.num('LOCK_ID1'),
        col.num('LOCK_ID2'),
      ],
      instance.lockManager.getBlockers().map(b => [
        b.waiterSid, b.holderSid, 'DML', 3, 6, 0, 0,
      ]),
    );
  },
});
