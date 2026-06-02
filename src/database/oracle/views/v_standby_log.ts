import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$STANDBY_LOG',
  comment: 'Standby redo logs',
  query({ instance }) {
    const rows: (string | number)[][] = [];
    instance.dataGuard.getStandbys().forEach((s, i) => {
      rows.push([
        i + 4, 1, 0, s.archiveDest, 1, 52428800,
        s.applyMode === 'APPLYING' ? 'ACTIVE' : 'UNASSIGNED',
        s.applyLagSeconds, 'NONE', s.dbUniqueName,
      ]);
    });
    return queryResult(
      [
        col.num('GROUP#'),
        col.num('THREAD#'),
        col.num('SEQUENCE#'),
        col.str('ARCHIVED', 256),
        col.num('BYTES'),
        col.num('USED'),
        col.str('STATUS', 10),
        col.num('FIRST_CHANGE#'),
        col.str('LAST_CHANGE#', 12),
        col.str('DBID', 30),
      ],
      rows,
    );
  },
});
