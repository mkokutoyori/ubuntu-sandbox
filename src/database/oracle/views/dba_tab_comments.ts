/**
 * DBA_TAB_COMMENTS — table and view comments.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_TAB_COMMENTS',
  comment: 'Comments on tables and views',
  query({ storage }) {
    const rows: (string | null)[][] = [];
    for (const t of storage.getAllTables()) rows.push([t.schema, t.name, 'TABLE', null]);
    for (const v of storage.getAllViews()) rows.push([v.schema, v.name, 'VIEW', null]);
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('TABLE_NAME', 30),
        col.str('TABLE_TYPE', 11),
        col.str('COMMENTS', 4000),
      ],
      rows
    );
  },
});
