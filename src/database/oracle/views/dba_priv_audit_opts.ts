/**
 * DBA_PRIV_AUDIT_OPTS — privilege-level audit options.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_PRIV_AUDIT_OPTS',
  comment: 'Privilege audit options',
  query() {
    return queryResult(
      [
        col.str('USER_NAME', 128),
        col.str('PROXY_NAME', 128),
        col.str('PRIVILEGE', 40),
        col.str('SUCCESS', 10),
        col.str('FAILURE', 10),
      ],
      []
    );
  },
});
