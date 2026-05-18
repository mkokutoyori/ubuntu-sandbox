/**
 * DICT_COLUMNS — column metadata for catalogue tables/views.
 *
 * Built from the registered view definitions: each query returns a
 * shaped ResultSet with column metadata, which we project as DICT_COLUMNS.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView, listRegisteredViews } from './registry';

registerView({
  name: 'DICT_COLUMNS',
  comment: 'Column metadata for catalogue objects',
  query(ctx) {
    const rows: (string | null)[][] = [];
    for (const def of listRegisteredViews()) {
      // Skip self to avoid infinite recursion and skip heavy historical
      // / synthesised views whose introspection only needs their column
      // shape, not their data.
      if (def.name === 'DICT_COLUMNS') continue;
      if (def.name.startsWith('DBA_HIST_')) continue;
      if (def.name === 'V$ACTIVE_SESSION_HISTORY') continue;
      if (def.name === 'V$SYSMETRIC_HISTORY') continue;
      if (def.name === 'V$SESSION_METRIC_HISTORY') continue;
      try {
        const sample = def.query(ctx);
        for (const c of sample.columns) {
          rows.push([def.name, c.name, def.comment ?? null]);
        }
      } catch {
        // Ignore views that error during introspection — they still
        // appear via DICTIONARY, just not their column detail.
      }
    }
    return queryResult(
      [col.str('TABLE_NAME', 30), col.str('COLUMN_NAME', 30), col.str('COMMENTS', 4000)],
      rows
    );
  },
});
