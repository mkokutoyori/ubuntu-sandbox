/**
 * REDACTION_POLICIES — one row per Data Redaction policy. Native to
 * Oracle 12c+; populated by DBMS_REDACT.ADD_POLICY.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'REDACTION_POLICIES',
  comment: 'Data Redaction policies (DBMS_REDACT)',
  query({ instance }) {
    return queryResult(
      [
        col.str('OBJECT_OWNER', 128),
        col.str('OBJECT_NAME', 128),
        col.str('POLICY_NAME', 128),
        col.str('EXPRESSION', 4000),
        col.str('ENABLE', 3),
        col.str('POLICY_DESCRIPTION', 4000),
      ],
      instance.redaction.getPolicies().map(p => [
        p.objectOwner, p.objectName, p.policyName, p.expression,
        p.enabled ? 'YES' : 'NO', p.policyDescription,
      ]),
    );
  },
});
