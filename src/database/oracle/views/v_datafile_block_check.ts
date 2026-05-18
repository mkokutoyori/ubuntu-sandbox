/**
 * V$DATAFILE_BLOCK_CHECK — last DBVERIFY result for each datafile.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$DATAFILE_BLOCK_CHECK',
  comment: 'Last DBVERIFY result per datafile',
  query({ storage }) {
    const rows: (string | number)[][] = [];
    let f = 1;
    for (const ts of storage.getAllTablespaces()) {
      for (const _df of ts.datafiles) {
        rows.push([f++, ts.name, 'COMPLETED', 0, 0, new Date().toISOString()]);
      }
    }
    return queryResult(
      [
        col.num('FILE#'),
        col.str('TABLESPACE_NAME', 30),
        col.str('STATUS', 13),
        col.num('CORRUPT_BLOCKS'),
        col.num('TOTAL_BLOCKS'),
        col.date('CHECK_TIME'),
      ],
      rows
    );
  },
});
