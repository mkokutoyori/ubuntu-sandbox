/**
 * DBA_POLICY_GROUPS — VPD policy groups.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_POLICY_GROUPS',
  comment: 'VPD policy groups',
  query() {
    return queryResult(
      [
        col.str('OBJECT_OWNER', 30),
        col.str('OBJECT_NAME', 30),
        col.str('POLICY_GROUP', 30),
      ],
      []
    );
  },
});
