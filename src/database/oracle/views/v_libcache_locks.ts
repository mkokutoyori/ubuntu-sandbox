/**
 * V$LIBCACHE_LOCKS — library-cache locks held by sessions.
 *
 * Surfaces one ROW per active session × cached cursor combination —
 * a session is assumed to hold a NULL-mode lock on its currently
 * executing cursor.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$LIBCACHE_LOCKS',
  comment: 'Library cache locks held by sessions',
  query({ runtime }) {
    const rows: (string | number)[][] = [];
    for (const s of runtime.sessions.values()) {
      if (s.lastSqlId) {
        rows.push([s.sid, s.lastSqlId, 'NULL', 'NULL', 0, 'GRANTED']);
      }
    }
    return queryResult(
      [
        col.num('SID'),
        col.str('SQL_ID', 13),
        col.str('LOCK_MODE_HELD', 8),
        col.str('LOCK_MODE_REQUESTED', 8),
        col.num('WAIT_TIME'),
        col.str('STATE', 8),
      ],
      rows
    );
  },
});
