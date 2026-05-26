/**
 * DBA_HOST_ACES — flattened (host, principal, privilege) view of every
 * network ACL on the database. Native to Oracle 12c+.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_HOST_ACES',
  comment: 'Flattened network ACL entries by host',
  query({ instance }) {
    return queryResult(
      [
        col.str('HOST', 1000),
        col.num('LOWER_PORT'),
        col.num('UPPER_PORT'),
        col.str('ACL', 4000),
        col.str('ACE_ORDER', 30),
        col.str('START_DATE', 30),
        col.str('END_DATE', 30),
        col.str('GRANT_TYPE', 5),
        col.str('INVERTED_PRINCIPAL', 5),
        col.str('PRINCIPAL_TYPE', 5),
        col.str('PRINCIPAL', 128),
        col.str('PRIVILEGE', 30),
      ],
      instance.networkAcls.getHostAces().map(a => [
        a.host, a.lowerPort, a.upperPort, a.aclName, String(a.aceOrder),
        a.startDate ? a.startDate.toISOString() : '',
        a.endDate ? a.endDate.toISOString() : '',
        a.grantOrDeny, 'FALSE', a.principalType, a.principal, a.privilege,
      ]),
    );
  },
});
