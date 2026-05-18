/**
 * DBA_RSRC_GROUP_MAPPINGS — same as DBA_RSRC_MAPPINGS but grouped.
 */

import { queryView } from './registry';
import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_RSRC_GROUP_MAPPINGS',
  comment: 'Resource Manager session-to-group mappings (alias)',
  query(ctx) {
    return queryView('DBA_RSRC_MAPPINGS', ctx) ?? queryResult(
      [col.str('ATTRIBUTE', 30), col.str('VALUE', 128), col.str('CONSUMER_GROUP', 30)],
      []
    );
  },
});
