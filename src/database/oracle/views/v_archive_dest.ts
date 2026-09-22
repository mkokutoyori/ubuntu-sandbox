/**
 * V$ARCHIVE_DEST — archive log destinations from `log_archive_dest_*`
 * init parameters.
 *
 * Bound to the live parameter store via `oracle.instance.parameter-changed`.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { readArchiveDestinations } from '../dataguard/ArchiveDestination';

registerView({
  name: 'V$ARCHIVE_DEST',
  comment: 'Archive log destination configuration',
  query({ instance }) {
    const rows: (string | number | null)[][] = [];
    for (const dest of readArchiveDestinations(instance.getAllParameters())) {
      const i = dest.destId;
      if (dest.kind === 'UNSET') {
        rows.push([i, `LOG_ARCHIVE_DEST_${i}`, 'INACTIVE', null, 'OPTIONAL', 0, 0, '', 'VALID', 'PRIMARY', 'ARCH', 'ACTIVE']);
        continue;
      }
      const etat = instance.getTransportState(i);
      const statut = dest.state === 'DEFER' ? 'DEFERRED'
        : etat?.status === 'ERROR' ? 'ERROR'
          : 'VALID';
      rows.push([
        i, `LOG_ARCHIVE_DEST_${i}`, statut, dest.target, dest.binding,
        etat?.sequence ?? 0, 0, dest.raw,
        dest.kind === 'SERVICE' ? 'STANDBY_LOGFILE' : 'ONLINE_LOGFILE',
        dest.validRole === 'STANDBY_ROLE' ? 'STANDBY' : 'PRIMARY',
        dest.kind === 'SERVICE' ? 'LGWR' : 'ARCH', 'ACTIVE',
      ]);
    }
    return queryResult(
      [
        col.num('DEST_ID'),
        col.str('DEST_NAME', 30),
        col.str('STATUS', 9),
        col.str('DESTINATION', 256),
        col.str('BINDING', 9),
        col.num('LOG_SEQUENCE'),
        col.num('REOPEN_SECS'),
        col.str('TARGET', 7),
        col.str('VALID_TYPE', 16),
        col.str('VALID_ROLE', 11),
        col.str('ARCHIVER', 10),
        col.str('SCHEDULE', 8),
      ],
      rows
    );
  },
});
