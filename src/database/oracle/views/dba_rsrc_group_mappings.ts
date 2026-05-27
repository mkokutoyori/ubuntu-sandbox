/**
 * DBA_RSRC_GROUP_MAPPINGS — Resource Manager session-to-group mappings.
 * Backed by ResourceManager.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_RSRC_GROUP_MAPPINGS',
  comment: 'Resource Manager session-to-group mappings',
  query({ instance }) {
    return queryResult(
      [
        col.str('ATTRIBUTE', 30),
        col.str('VALUE', 128),
        col.str('CONSUMER_GROUP', 30),
        col.str('STATUS', 16),
      ],
      instance.resourceManager.getMappings().map(m => [
        m.attribute, m.value, m.consumerGroup, m.status,
      ]),
    );
  },
});
