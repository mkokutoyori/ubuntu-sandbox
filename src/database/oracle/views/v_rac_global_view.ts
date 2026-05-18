/**
 * V$RAC_GLOBAL_VIEW — directory of GV$ views.
 *
 * In a real cluster this lists every GV$ view name and the V$ view it
 * aggregates. Since our catalog auto-derives GV$X from V$X for any
 * registered view, we emit a one-row-per-known-V$-view mapping.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { listRegisteredViews } from './registry';

registerView({
  name: 'V$RAC_GLOBAL_VIEW',
  comment: 'Directory of GV$/V$ aggregations',
  query() {
    const names = listRegisteredViews()
      .map(v => v.name)
      .filter(n => n.startsWith('V$'))
      .sort();
    return queryResult(
      [col.str('NAME_ROOT', 64), col.str('GV_NAME', 64), col.str('V_NAME', 64)],
      names.map(n => [n.substring(2), `G${n}`, n])
    );
  },
});
