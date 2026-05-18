/**
 * DBA_AUDIT_POLICIES — fine-grained audit policies.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_AUDIT_POLICIES',
  comment: 'FGA policies',
  query() {
    return queryResult(
      [
        col.str('OBJECT_SCHEMA', 30),
        col.str('OBJECT_NAME', 30),
        col.str('POLICY_OWNER', 30),
        col.str('POLICY_NAME', 30),
        col.str('POLICY_TEXT', 4000),
        col.str('ENABLED', 3),
        col.str('SEL', 3),
        col.str('INS', 3),
        col.str('UPD', 3),
        col.str('DEL', 3),
      ],
      []
    );
  },
});
