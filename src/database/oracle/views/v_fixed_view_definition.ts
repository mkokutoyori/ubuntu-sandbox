/**
 * V$FIXED_VIEW_DEFINITION — placeholder definitions for each fixed view.
 *
 * Real Oracle stores the SQL underlying GV$X views. Since our views are
 * computed in TypeScript, we surface a synthetic "SELECT * FROM X$..."
 * placeholder.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView, listRegisteredViews } from './registry';

registerView({
  name: 'V$FIXED_VIEW_DEFINITION',
  comment: 'Definitions of fixed views',
  query() {
    return queryResult(
      [col.str('VIEW_NAME', 30), col.str('VIEW_DEFINITION', 4000)],
      listRegisteredViews()
        .filter(v => v.name.startsWith('V$') || v.name.startsWith('GV$'))
        .map(v => [v.name, `select * from x$${v.name.toLowerCase().replace(/[v$]/g, '')}`])
    );
  },
});
