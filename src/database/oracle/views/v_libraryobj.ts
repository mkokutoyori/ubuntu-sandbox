/**
 * V$LIBRARYOBJ — library cache object inventory.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$LIBRARYOBJ',
  comment: 'Library cache object inventory',
  query({ storage, runtime }) {
    const rows: (string | number)[][] = [];
    let id = 1;
    for (const t of storage.getAllTables()) {
      rows.push([id++, t.schema, t.name, 'TABLE', 'VALID']);
    }
    for (const v of storage.getAllViews()) {
      rows.push([id++, v.schema, v.name, 'VIEW', 'VALID']);
    }
    for (const s of runtime.sqlCache.values()) {
      rows.push([id++, s.parsingSchema, s.sqlId, 'SQL_AREA', 'VALID']);
    }
    return queryResult(
      [
        col.num('OBJ#'),
        col.str('OWNER', 30),
        col.str('NAME', 64),
        col.str('TYPE', 16),
        col.str('STATUS', 8),
      ],
      rows
    );
  },
});
