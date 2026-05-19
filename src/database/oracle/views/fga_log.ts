/**
 * SYS.FGA_LOG\$ — internal fine-grained-audit log table.
 *
 * Real Oracle stores FGA audit records here; DBA_FGA_AUDIT_TRAIL is the
 * public view. The simulator mirrors that flow — both views derive
 * from the catalog's FGA trail accessor (no duplicate state).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'FGA_LOG$',
  comment: 'Fine-grained audit log',
  query({ catalog }) {
    return queryResult(
      [
        { name: 'SESSIONID', dataType: oracleNumber(10) },
        { name: 'TIMESTAMP#', dataType: oracleDate() },
        { name: 'DBUID', dataType: oracleVarchar2(128) },
        { name: 'OSUID', dataType: oracleVarchar2(30) },
        { name: 'OBJ$SCHEMA', dataType: oracleVarchar2(30) },
        { name: 'OBJ$NAME', dataType: oracleVarchar2(30) },
        { name: 'POLICYNAME', dataType: oracleVarchar2(30) },
        { name: 'SCN', dataType: oracleNumber(20) },
        { name: 'SQLTEXT', dataType: oracleVarchar2(4000) },
        { name: 'STATEMENT_TYPE', dataType: oracleVarchar2(28) },
      ],
      catalog.getFgaTrail().map(f => [
        f.sessionId, f.timestamp.toISOString(),
        f.dbUser, f.osUser,
        f.objectSchema, f.objectName, f.policyName, 0,
        f.sqlText, f.statementType,
      ])
    );
  },
});
