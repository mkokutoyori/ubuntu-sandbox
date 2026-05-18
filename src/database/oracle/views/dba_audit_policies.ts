/**
 * DBA_AUDIT_POLICIES — fine-grained audit policies registered with
 * DBMS_FGA.ADD_POLICY (or via our catalog API).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_AUDIT_POLICIES',
  comment: 'FGA policies',
  query({ catalog }) {
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
      catalog.getFgaPolicies().map(p => [
        p.objectSchema, p.objectName, p.policyOwner, p.policyName, p.policyText,
        p.enabled ? 'YES' : 'NO',
        p.select ? 'YES' : 'NO',
        p.insert ? 'YES' : 'NO',
        p.update ? 'YES' : 'NO',
        p.delete ? 'YES' : 'NO',
      ])
    );
  },
});
