/**
 * V$SYSTEM_METRIC_HISTORY — alias of V$SYSMETRIC_HISTORY.
 */

import { queryView } from './registry';
import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SYSTEM_METRIC_HISTORY',
  comment: 'Alias of V$SYSMETRIC_HISTORY',
  query(ctx) {
    return queryView('V$SYSMETRIC_HISTORY', ctx) ?? queryResult(
      [col.date('BEGIN_TIME'), col.date('END_TIME'), col.str('METRIC_NAME', 64), col.num('VALUE')],
      []
    );
  },
});
