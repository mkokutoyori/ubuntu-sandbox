/**
 * DBA_RSRC_CONSUMER_GROUPS — Resource Manager consumer groups.
 * Backed by ResourceManager — every CREATE_CONSUMER_GROUP call shows
 * up here exactly as on a real database.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_RSRC_CONSUMER_GROUPS',
  comment: 'Resource Manager consumer groups',
  query({ instance }) {
    return queryResult(
      [
        col.str('CONSUMER_GROUP', 30),
        col.str('CPU_METHOD', 12),
        col.str('STATUS', 16),
        col.str('COMMENTS', 240),
        col.str('CATEGORY', 30),
        col.str('MANDATORY', 3),
      ],
      instance.resourceManager.getConsumerGroups().map(g => [
        g.name, g.cpuMethod, g.status, g.comment, g.category,
        g.mandatory ? 'YES' : 'NO',
      ]),
    );
  },
});
