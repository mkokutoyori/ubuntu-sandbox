/**
 * V$DATAFILE_HEADER — header status of each datafile.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$DATAFILE_HEADER',
  comment: 'Datafile header status',
  query({ storage, instance }) {
    const rows: (string | number)[][] = [];
    let fileNum = 1;
    for (const ts of storage.getAllTablespaces()) {
      for (const df of ts.datafiles) {
        rows.push([
          fileNum++, ts.name, df.path,
          instance.state === 'OPEN' ? 'ONLINE' : 'OFFLINE',
          'NO', 'AVAILABLE', df.size, 8192, 100, 0,
        ]);
      }
    }
    return queryResult(
      [
        col.num('FILE#'),
        col.str('TABLESPACE_NAME', 30),
        col.str('NAME', 513),
        col.str('STATUS', 7),
        col.str('ERROR', 18),
        col.str('FUZZY', 9),
        col.num('BYTES'),
        col.num('BLOCK_SIZE'),
        col.num('CHECKPOINT_CHANGE#'),
        col.num('CHECKPOINT_COUNT'),
      ],
      rows
    );
  },
});
