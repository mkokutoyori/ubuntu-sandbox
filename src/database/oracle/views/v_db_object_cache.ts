/**
 * V$DB_OBJECT_CACHE — library cache contents.
 *
 * Projects the storage's tables/views + the runtime SQL cache as a
 * unified "objects in the library cache" view.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$DB_OBJECT_CACHE',
  comment: 'Library cache objects',
  query({ storage, runtime }) {
    const rows: (string | number)[][] = [];
    for (const t of storage.getAllTables()) {
      rows.push([t.schema, t.name, 'TABLE', 'VALID', 1, 1, 0]);
    }
    for (const v of storage.getAllViews()) {
      rows.push([v.schema, v.name, 'VIEW', 'VALID', 1, 1, 0]);
    }
    for (const s of runtime.sqlCache.values()) {
      rows.push([s.parsingSchema, s.sqlId, 'CURSOR', 'VALID', s.executions, 1, s.text.length]);
    }
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('NAME', 64),
        col.str('TYPE', 16),
        col.str('STATUS', 8),
        col.num('EXECUTIONS'),
        col.num('LOADS'),
        col.num('SHARABLE_MEM'),
      ],
      rows
    );
  },
});
