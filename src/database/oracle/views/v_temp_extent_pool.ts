/**
 * V$TEMP_EXTENT_POOL — temp extent pool summary.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$TEMP_EXTENT_POOL',
  comment: 'Temporary extent pool',
  query({ storage }) {
    const rows: (string | number)[][] = [];
    for (const ts of storage.getAllTablespaces().filter(t => t.type === 'TEMPORARY')) {
      for (let i = 0; i < ts.datafiles.length; i++) {
        const total = Number(ts.datafiles[i].size) || 0;
        rows.push([ts.name, i + 1, Math.floor(total / 8192), Math.floor(total * 0.7 / 8192), 0]);
      }
    }
    return queryResult(
      [
        col.str('TABLESPACE_NAME', 30),
        col.num('FILE_ID'),
        col.num('EXTENTS_CACHED'),
        col.num('EXTENTS_USED'),
        col.num('BLOCKS_CACHED'),
      ],
      rows
    );
  },
});
