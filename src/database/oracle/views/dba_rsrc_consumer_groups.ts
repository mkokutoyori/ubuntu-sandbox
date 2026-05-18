/**
 * DBA_RSRC_CONSUMER_GROUPS — Resource Manager consumer groups.
 *
 * Oracle ships a default set of consumer groups.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const GROUPS = [
  'SYS_GROUP', 'OTHER_GROUPS', 'DEFAULT_CONSUMER_GROUP',
  'ORA$AUTOTASK', 'ORA$DIAGNOSTICS', 'BATCH_GROUP', 'INTERACTIVE_GROUP',
  'LOW_GROUP', 'MEDIUM_GROUP',
];

registerView({
  name: 'DBA_RSRC_CONSUMER_GROUPS',
  comment: 'Resource Manager consumer groups',
  query() {
    return queryResult(
      [
        col.str('CONSUMER_GROUP', 30),
        col.str('CPU_METHOD', 12),
        col.str('STATUS', 16),
        col.str('COMMENTS', 240),
      ],
      GROUPS.map(g => [g, 'ROUND-ROBIN', 'ACTIVE', `${g} consumer group`])
    );
  },
});
