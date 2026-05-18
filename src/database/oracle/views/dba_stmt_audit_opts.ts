/**
 * DBA_STMT_AUDIT_OPTS — configured statement audit options, from the
 * catalog audit-option store.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_STMT_AUDIT_OPTS',
  comment: 'Statement audit options',
  query({ catalog }) {
    return queryResult(
      [
        { name: 'USER_NAME', dataType: oracleVarchar2(128) },
        { name: 'AUDIT_OPTION', dataType: oracleVarchar2(40) },
        { name: 'SUCCESS', dataType: oracleVarchar2(10) },
        { name: 'FAILURE', dataType: oracleVarchar2(10) },
      ],
      catalog.getStmtAuditOpts().map(o => [o.userName, o.auditOption, o.success, o.failure])
    );
  },
});
