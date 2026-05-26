/**
 * DBA_NETWORK_ACLS — host/port → ACL mapping
 * (native to Oracle 12c+, populated by DBMS_NETWORK_ACL_ADMIN).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_NETWORK_ACLS',
  comment: 'Host/port to ACL bindings',
  query({ instance }) {
    return queryResult(
      [
        col.str('HOST', 1000),
        col.num('LOWER_PORT'),
        col.num('UPPER_PORT'),
        col.str('ACL', 4000),
        col.str('ACLID', 32),
        col.str('ACL_OWNER', 128),
      ],
      instance.networkAcls.getAcls().map(a => [
        a.host, a.lowerPort, a.upperPort, a.aclName, a.aclId, a.aclOwner,
      ]),
    );
  },
});
