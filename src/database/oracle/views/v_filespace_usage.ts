/**
 * V$FILESPACE_USAGE — per-datafile space usage.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$FILESPACE_USAGE',
  comment: 'Per-datafile space usage',
  query({ storage }) {
    const rows: (string | number)[][] = [];
    let f = 1;
    for (const ts of storage.getAllTablespaces()) {
      for (const df of ts.datafiles) {
        const total = Number(df.size) || 1;
        rows.push([f++, 0, Math.floor(total * 0.3 / 8192), Math.floor(total / 8192)]);
      }
    }
    return queryResult(
      [
        col.num('TABLESPACE_ID'),
        col.num('FILE_NUMBER'),
        col.num('ALLOCATED_SPACE'),
        col.num('FILE_SIZE'),
      ],
      rows
    );
  },
});
