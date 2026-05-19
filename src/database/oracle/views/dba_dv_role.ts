/**
 * DBA_DV_ROLE — Database Vault secure application roles. Reads live
 * catalog state.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_DV_ROLE',
  comment: 'Database Vault secure application roles',
  query({ catalog }) {
    const c = catalog as unknown as { getDvRoles?: () => { name: string; enabled: boolean; ruleSetName: string }[] };
    const rows = c.getDvRoles ? c.getDvRoles() : [];
    return queryResult(
      [
        col.str('ROLE', 30),
        col.str('ENABLED', 1),
        col.str('RULE_SET_NAME', 90),
      ],
      rows.map(r => [r.name, r.enabled ? 'Y' : 'N', r.ruleSetName])
    );
  },
});
