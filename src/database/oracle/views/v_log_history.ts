/**
 * V$LOG_HISTORY — historical online redo log sequences.
 *
 * Each `oracle.archive-log.created` event surfaces here as a row, since
 * a switched-out group becomes a piece of redo history.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$LOG_HISTORY',
  comment: 'Online redo log history',
  query({ runtime }) {
    return queryResult(
      [
        col.num('RECID'),
        col.num('STAMP'),
        col.num('THREAD#'),
        col.num('SEQUENCE#'),
        col.date('FIRST_TIME'),
        col.num('FIRST_CHANGE#'),
        col.num('NEXT_CHANGE#'),
        col.str('ARCHIVED', 3),
        col.num('RESETLOGS_CHANGE#'),
        col.date('RESETLOGS_TIME'),
      ],
      runtime.archivedLogs.map((l, idx) => [
        l.recid, l.firstTime, 1, l.sequence,
        new Date(l.firstTime).toISOString(),
        100 + idx, 100 + idx + 1,
        'YES', 1, new Date('2026-01-01T00:00:00Z'),
      ])
    );
  },
});
