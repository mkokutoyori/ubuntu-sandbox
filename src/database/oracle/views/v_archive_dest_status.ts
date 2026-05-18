/**
 * V$ARCHIVE_DEST_STATUS — runtime archive destination status.
 *
 * Reads the live archive log mode and the archive-log count maintained
 * by `OracleRuntimeStateActor` (oracle.archive-log.created events).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$ARCHIVE_DEST_STATUS',
  comment: 'Archive destination runtime status',
  query({ instance, runtime }) {
    const rows: (string | number)[][] = [];
    for (let i = 1; i <= 31; i++) {
      const param = instance.getParameter(`log_archive_dest_${i}`);
      const active = i === 1 && instance.archiveLogMode;
      rows.push([
        i, param ? 'ALTERNATE' : 'INACTIVE',
        active ? 'VALID' : 'DEFERRED',
        instance.archiveLogMode ? 'PRIMARY' : 'NONE',
        active ? runtime.counters.archiveLogs : 0,
        active ? runtime.archivedLogs[runtime.archivedLogs.length - 1]?.sequence ?? 0 : 0,
        '',
      ]);
    }
    return queryResult(
      [
        col.num('DEST_ID'),
        col.str('STATUS', 9),
        col.str('TYPE', 16),
        col.str('DATABASE_MODE', 16),
        col.num('LOG_SEQUENCE'),
        col.num('LATEST_LOG'),
        col.str('ERROR', 256),
      ],
      rows
    );
  },
});
