/**
 * DBA_RSRC_PLANS — Resource Manager plans.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const PLANS = [
  'DEFAULT_PLAN', 'DEFAULT_MAINTENANCE_PLAN', 'INTERNAL_PLAN',
  'INTERNAL_QUIESCE',
];

registerView({
  name: 'DBA_RSRC_PLANS',
  comment: 'Resource Manager plans',
  query() {
    return queryResult(
      [
        col.str('PLAN', 30),
        col.str('CPU_METHOD', 12),
        col.str('STATUS', 16),
        col.str('COMMENTS', 240),
      ],
      PLANS.map(p => [p, 'EMPHASIS', 'ACTIVE', `${p} plan`])
    );
  },
});
