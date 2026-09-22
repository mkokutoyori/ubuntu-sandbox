/**
 * V$ARCHIVE_DEST_STATUS — runtime archive destination status.
 *
 * Reads the live archive log mode and the archive-log count maintained
 * by `OracleRuntimeStateActor` (oracle.archive-log.created events).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { readArchiveDestinations } from '../dataguard/ArchiveDestination';

registerView({
  name: 'V$ARCHIVE_DEST_STATUS',
  comment: 'Archive destination runtime status',
  query({ instance, runtime }) {
    const rows: (string | number)[][] = [];
    for (const dest of readArchiveDestinations(instance.getAllParameters())) {
      const i = dest.destId;
      const etat = instance.getTransportState(i);
      const local = dest.kind === 'LOCATION' && instance.archiveLogMode;
      const statut = dest.kind === 'UNSET' ? 'INACTIVE'
        : dest.state === 'DEFER' ? 'DEFERRED'
          : etat?.status === 'ERROR' ? 'ERROR'
            : 'VALID';
      rows.push([
        i, statut,
        dest.kind === 'SERVICE' ? 'PHYSICAL' : 'LOCAL',
        instance.archiveLogMode ? 'PRIMARY' : 'NONE',
        local ? runtime.counters.archiveLogs : etat?.sequence ?? 0,
        local
          ? runtime.archivedLogs[runtime.archivedLogs.length - 1]?.sequence ?? 0
          : etat?.sequence ?? 0,
        etat?.error ?? '',
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
