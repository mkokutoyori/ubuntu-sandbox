/**
 * V$SORT_SEGMENT — temporary segment headers (high-water mark, free, used).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SORT_SEGMENT',
  comment: 'Temporary sort segment headers',
  query({ storage }) {
    return queryResult(
      [
        col.str('TABLESPACE_NAME', 30),
        col.num('EXTENT_SIZE'),
        col.num('TOTAL_EXTENTS'),
        col.num('TOTAL_BLOCKS'),
        col.num('USED_EXTENTS'),
        col.num('USED_BLOCKS'),
        col.num('FREE_EXTENTS'),
        col.num('FREE_BLOCKS'),
        col.num('MAX_USED_SIZE'),
        col.num('MAX_USED_BLOCKS'),
      ],
      storage.getAllTablespaces().filter(ts => ts.type === 'TEMPORARY').map(ts => {
        const totalBlocks = ts.datafiles.reduce((s, df) => s + Math.floor(Number(df.size) / 8192), 0);
        return [ts.name, 128, totalBlocks / 128, totalBlocks, 1, 128, totalBlocks / 128 - 1, totalBlocks - 128, 1, 128];
      })
    );
  },
});
