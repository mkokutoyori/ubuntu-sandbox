/**
 * DBA_RSRC_PLAN_DIRECTIVES — directives that map plans to consumer groups.
 * Backed by ResourceManager.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_RSRC_PLAN_DIRECTIVES',
  comment: 'Resource Manager plan directives',
  query({ instance }) {
    return queryResult(
      [
        col.str('PLAN', 30),
        col.str('GROUP_OR_SUBPLAN', 30),
        col.str('TYPE', 14),
        col.num('MGMT_P1'),
        col.num('ACTIVE_SESS_POOL_P1'),
        col.num('QUEUEING_P1'),
        col.num('SWITCH_TIME'),
        col.str('SWITCH_GROUP', 30),
        col.num('MAX_IDLE_TIME'),
        col.num('MAX_EST_EXEC_TIME'),
        col.str('COMMENTS', 240),
      ],
      instance.resourceManager.getDirectives().map(d => [
        d.plan, d.groupOrSubplan, d.type, d.mgmtP1,
        d.activeSessPool, d.queueingP1, d.switchTime,
        d.switchGroup, d.maxIdleTime, d.maxEstExecTime, d.comment,
      ]),
    );
  },
});
