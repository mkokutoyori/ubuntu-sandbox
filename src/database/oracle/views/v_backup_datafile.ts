/**
 * V$BACKUP_DATAFILE — per-datafile backup history.
 *
 * Fed by `oracle.backup.recorded` (kind FULL / INCREMENTAL only).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$BACKUP_DATAFILE',
  comment: 'Backup history per datafile',
  query({ runtime, storage }) {
    const datafiles = storage.getAllTablespaces().flatMap(ts =>
      ts.datafiles.map((df, i) => ({ ts: ts.name, file: i + 1, path: df.path }))
    );
    const rows: (string | number)[][] = [];
    let recId = 1;
    for (const b of runtime.backups.filter(x => x.type === 'FULL' || x.type === 'INCREMENTAL')) {
      datafiles.forEach(df => {
        rows.push([
          recId++, b.setId, df.file, df.path,
          b.bytes, b.type === 'INCREMENTAL' ? 1 : 0,
          new Date(b.startedAt).toISOString(),
          new Date(b.completedAt).toISOString(),
        ]);
      });
    }
    return queryResult(
      [
        col.num('RECID'),
        col.num('SET_STAMP'),
        col.num('FILE#'),
        col.str('NAME', 513),
        col.num('DATAFILE_BLOCKS'),
        col.num('INCREMENTAL_LEVEL'),
        col.date('CHECKPOINT_TIME'),
        col.date('COMPLETION_TIME'),
      ],
      rows
    );
  },
});
