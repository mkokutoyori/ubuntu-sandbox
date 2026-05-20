/**
 * DBA_DV_REALM_AUTH — Database Vault realm authorisations. Reads live
 * catalog state.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_DV_REALM_AUTH',
  comment: 'Database Vault realm authorisations',
  query({ catalog }) {
    const c = catalog as unknown as { getDvRealmAuth?: () => { realmName: string; grantee: string; authRuleSetName: string; authOptions: string }[] };
    const rows = c.getDvRealmAuth ? c.getDvRealmAuth() : [];
    return queryResult(
      [
        col.str('REALM_NAME', 90),
        col.str('GRANTEE', 30),
        col.str('AUTH_RULE_SET_NAME', 90),
        col.str('AUTH_OPTIONS', 30),
      ],
      rows.map(r => [r.realmName, r.grantee, r.authRuleSetName, r.authOptions])
    );
  },
});
