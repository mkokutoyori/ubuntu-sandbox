/**
 * V$SQLFN_ARG_METADATA — argument metadata for V$SQLFN_METADATA.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { SQLFN_CATALOGUE } from './v_sqlfn_metadata';

registerView({
  name: 'V$SQLFN_ARG_METADATA',
  comment: 'Per-argument metadata for SQL functions',
  query() {
    const rows: (string | number)[][] = [];
    for (const f of SQLFN_CATALOGUE) {
      const n = f.args === -1 ? 2 : f.args;
      for (let i = 1; i <= n; i++) {
        rows.push([f.funcId, i, f.returnType, 'IN', f.name]);
      }
    }
    return queryResult(
      [
        col.num('FUNC_ID'),
        col.num('ARGNUM'),
        col.str('DATATYPE', 16),
        col.str('DIRECTION', 4),
        col.str('FUNC_NAME', 30),
      ],
      rows
    );
  },
});
