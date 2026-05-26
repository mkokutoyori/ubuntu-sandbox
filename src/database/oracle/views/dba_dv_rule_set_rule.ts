/**
 * DBA_DV_RULE_SET_RULE — mapping of rules into rule sets. In the
 * simulator each policy has exactly one rule sharing its name.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_DV_RULE_SET_RULE',
  comment: 'Rule-to-ruleset assignments',
  query({ instance }) {
    const policies = instance.getAuditJournal().getSodPolicies();
    return queryResult(
      [
        col.str('RULE_SET_NAME', 90),
        col.str('RULE_NAME', 90),
        col.str('RULE_EXPR', 4000),
        col.str('ENABLED', 1),
      ],
      policies.map(p => [
        p.name, p.name,
        p.conflictingPrivileges.map(t => `DBMS_MACUTL.USER_HAS_PRIV('${t}')`).join(' AND '),
        p.enabled ? 'Y' : 'N',
      ]),
    );
  },
});
