/**
 * DBA_RSRC_MAPPINGS — Resource Manager session-to-group mappings.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_RSRC_MAPPINGS',
  comment: 'Resource Manager session-to-group mappings',
  query() {
    return queryResult(
      [
        col.str('ATTRIBUTE', 30),
        col.str('VALUE', 128),
        col.str('CONSUMER_GROUP', 30),
        col.str('STATUS', 16),
      ],
      [
        ['ORACLE_USER', 'SYS', 'SYS_GROUP', 'ACTIVE'],
        ['ORACLE_USER', 'SYSTEM', 'SYS_GROUP', 'ACTIVE'],
      ]
    );
  },
});
