/**
 * V$SYSTEM_METRIC — alias of V$SYSMETRIC for compatibility.
 */

import { queryView } from './registry';
import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SYSTEM_METRIC',
  comment: 'Alias of V$SYSMETRIC',
  query(ctx) {
    return queryView('V$SYSMETRIC', ctx) ?? queryResult(
      [col.date('BEGIN_TIME'), col.date('END_TIME'), col.str('METRIC_NAME', 64), col.num('VALUE')],
      []
    );
  },
});
