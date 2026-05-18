/**
 * DBA_POLICIES — VPD (virtual private database) policies.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_POLICIES',
  comment: 'VPD policies',
  query() {
    return queryResult(
      [
        col.str('OBJECT_OWNER', 30),
        col.str('OBJECT_NAME', 30),
        col.str('POLICY_NAME', 30),
        col.str('PF_OWNER', 30),
        col.str('PACKAGE', 30),
        col.str('FUNCTION', 30),
        col.str('SEL', 3),
        col.str('INS', 3),
        col.str('UPD', 3),
        col.str('DEL', 3),
      ],
      []
    );
  },
});
