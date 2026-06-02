/**
 * DBA_RSRC_PLANS — Resource Manager plans. Backed by ResourceManager.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_RSRC_PLANS',
  comment: 'Resource Manager plans',
  query({ instance }) {
    return queryResult(
      [
        col.str('PLAN', 30),
        col.str('CPU_METHOD', 12),
        col.str('STATUS', 16),
        col.str('COMMENTS', 240),
        col.str('MANDATORY', 3),
        col.str('SUB_PLAN', 3),
      ],
      instance.resourceManager.getPlans().map(p => [
        p.name, p.cpuMethod, p.status, p.comment,
        p.mandatory ? 'YES' : 'NO',
        p.subPlan ? 'YES' : 'NO',
      ]),
    );
  },
});
