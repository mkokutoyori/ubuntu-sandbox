/**
 * V$SQL_SHARED_MEMORY — shared memory consumed by each cursor.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SQL_SHARED_MEMORY',
  comment: 'Shared memory consumed by each cursor',
  query({ runtime }) {
    return queryResult(
      [
        col.str('SQL_ID', 13),
        col.num('ADDRESS'),
        col.num('CHILD_NUMBER'),
        col.num('CHUNK_PTR'),
        col.num('CHUNK_SIZE'),
        col.str('ALLOC_CLASS', 8),
        col.str('CHUNK_TYPE', 16),
      ],
      [...runtime.sqlCache.values()].map(s => [
        s.sqlId, 0, 0, 0, s.text.length * 8, 'PERM', 'SQLA',
      ])
    );
  },
});
