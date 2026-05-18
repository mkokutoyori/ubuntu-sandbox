/**
 * V$RMAN_OUTPUT — log lines produced by RMAN sessions.
 *
 * Each backup recorded via `oracle.backup.recorded` emits two
 * informational lines.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$RMAN_OUTPUT',
  comment: 'RMAN log output by session',
  query({ runtime }) {
    const rows: (string | number)[][] = [];
    runtime.backups.forEach((b, idx) => {
      rows.push([
        idx * 2 + 1, b.setId,
        new Date(b.startedAt).toISOString(),
        `Starting ${b.type} backup ${b.handle}`,
      ]);
      rows.push([
        idx * 2 + 2, b.setId,
        new Date(b.completedAt).toISOString(),
        `${b.type} backup ${b.handle} ${b.status} (${b.bytes} bytes)`,
      ]);
    });
    return queryResult(
      [
        col.num('SID'),
        col.num('RECID'),
        col.date('OUTPUT_DATE'),
        col.str('OUTPUT', 130),
      ],
      rows
    );
  },
});
