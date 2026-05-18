/**
 * DBA_AUDIT_TRAIL — full audit trail, from the catalog audit store.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_AUDIT_TRAIL',
  comment: 'Audit trail entries',
  query({ catalog }) {
    return queryResult(
      [
        { name: 'OS_USERNAME', dataType: oracleVarchar2(255) },
        { name: 'USERNAME', dataType: oracleVarchar2(128) },
        { name: 'USERHOST', dataType: oracleVarchar2(128) },
        { name: 'TIMESTAMP', dataType: oracleDate() },
        { name: 'ACTION_NAME', dataType: oracleVarchar2(28) },
        { name: 'OBJ_NAME', dataType: oracleVarchar2(128) },
        { name: 'RETURNCODE', dataType: oracleNumber(10) },
        { name: 'OBJ_OWNER', dataType: oracleVarchar2(128) },
        { name: 'SESSIONID', dataType: oracleNumber(10) },
        { name: 'PRIV_USED', dataType: oracleVarchar2(40) },
        { name: 'SQL_TEXT', dataType: oracleVarchar2(2000) },
        { name: 'STATEMENT_TYPE', dataType: oracleVarchar2(28) },
      ],
      catalog.getAuditTrail().map(e => [
        e.osUsername, e.username, e.userhost, e.timestamp.toISOString(),
        e.actionName, e.objName, e.returncode, e.objOwner,
        e.sessionId, e.privUsed, e.sqlText, e.statementType,
      ])
    );
  },
});
