/**
 * DBA_NETWORK_ACL_PRIVILEGES — principal/privilege rows attached to
 * each ACL (native to Oracle 12c+).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_NETWORK_ACL_PRIVILEGES',
  comment: 'Principal/privilege entries on each network ACL',
  query({ instance }) {
    return queryResult(
      [
        col.str('ACL', 4000),
        col.str('ACLID', 32),
        col.str('PRINCIPAL', 128),
        col.str('PRIVILEGE', 30),
        col.str('IS_GRANT', 5),
        col.str('INVERT', 5),
        col.str('PRINCIPAL_TYPE', 5),
        col.date('START_DATE'),
        col.date('END_DATE'),
        col.num('ACE_ORDER'),
      ],
      instance.networkAcls.getPrivileges().map(p => {
        const acl = instance.networkAcls.getAcls().find(a => a.aclName === p.aclName);
        return [
          p.aclName, acl?.aclId ?? '', p.principal, p.privilege,
          p.isGrant ? 'TRUE' : 'FALSE',
          p.invertedPrincipal ? 'TRUE' : 'FALSE',
          p.principalType,
          p.startDate ? p.startDate.toISOString() : null,
          p.endDate ? p.endDate.toISOString() : null,
          p.position,
        ];
      }),
    );
  },
});
