/**
 * V$FIXED_TABLE — catalogue of every X$/V$/GV$ fixed table.
 *
 * Built from `listRegisteredViews()` so it always reflects the current
 * set of registered views. No need to maintain a parallel list.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView, listRegisteredViews } from './registry';

registerView({
  name: 'V$FIXED_TABLE',
  comment: 'Catalogue of fixed (V$/GV$/X$) tables',
  query() {
    const rows: (string | number)[][] = [];
    let objId = 4259840;
    for (const v of listRegisteredViews()) {
      if (v.name.startsWith('V$') || v.name.startsWith('GV$') || v.name.startsWith('X$')) {
        rows.push([v.name, objId++, v.name.startsWith('GV$') ? 'TABLE' : 'VIEW', 1]);
        if (v.name.startsWith('V$')) {
          rows.push([`G${v.name}`, objId++, 'TABLE', 1]);
        }
      }
    }
    return queryResult(
      [
        col.str('NAME', 30),
        col.num('OBJECT_ID'),
        col.str('TYPE', 5),
        col.num('TABLE_NUM'),
      ],
      rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    );
  },
});
