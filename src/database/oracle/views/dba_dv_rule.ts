/**
 * DBA_DV_RULE — Database Vault rule definitions.
 *
 * The simulator surfaces each SoD policy as one DV rule named after the
 * policy (the simulator's SoD subsystem is conceptually a DV-Lite).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_DV_RULE',
  comment: 'Database Vault rule definitions',
  query({ instance }) {
    const policies = instance.getAuditJournal().getSodPolicies();
    return queryResult(
      [
        col.str('NAME', 90),
        col.str('RULE_EXPR', 4000),
        col.str('ENABLED', 1),
        col.str('DESCRIPTION', 1024),
      ],
      policies.map(p => [
        p.name,
        // Render the SoD predicate the way DV's CREATE_RULE would:
        // "AND HAS_PRIV"-chained across all conflicting tokens.
        p.conflictingPrivileges.map(t => `DBMS_MACUTL.USER_HAS_PRIV('${t}')`).join(' AND '),
        p.enabled ? 'Y' : 'N',
        p.description,
      ]),
    );
  },
});
