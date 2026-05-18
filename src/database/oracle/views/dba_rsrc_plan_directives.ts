/**
 * DBA_RSRC_PLAN_DIRECTIVES — directives that map plans to consumer groups.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_RSRC_PLAN_DIRECTIVES',
  comment: 'Resource Manager plan directives',
  query() {
    return queryResult(
      [
        col.str('PLAN', 30),
        col.str('GROUP_OR_SUBPLAN', 30),
        col.str('TYPE', 14),
        col.num('CPU_P1'),
        col.num('CPU_P2'),
        col.str('STATUS', 16),
      ],
      [
        ['DEFAULT_PLAN', 'SYS_GROUP', 'CONSUMER_GROUP', 100, 0, 'ACTIVE'],
        ['DEFAULT_PLAN', 'OTHER_GROUPS', 'CONSUMER_GROUP', 0, 100, 'ACTIVE'],
        ['DEFAULT_MAINTENANCE_PLAN', 'SYS_GROUP', 'CONSUMER_GROUP', 75, 0, 'ACTIVE'],
        ['DEFAULT_MAINTENANCE_PLAN', 'ORA$AUTOTASK', 'CONSUMER_GROUP', 25, 0, 'ACTIVE'],
      ]
    );
  },
});
