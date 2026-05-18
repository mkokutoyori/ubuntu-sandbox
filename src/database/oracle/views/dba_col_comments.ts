/**
 * DBA_COL_COMMENTS — column comments.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_COL_COMMENTS',
  comment: 'Comments on columns',
  query({ storage }) {
    const rows: (string | null)[][] = [];
    for (const t of storage.getAllTables()) {
      for (const c of t.columns) {
        rows.push([t.schema, t.name, c.name, null]);
      }
    }
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('TABLE_NAME', 30),
        col.str('COLUMN_NAME', 30),
        col.str('COMMENTS', 4000),
      ],
      rows
    );
  },
});
