/**
 * SYS.AUD$ — raw audit table, from the catalog audit store. Action
 * names are mapped to Oracle's numeric ACTION# codes.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

const ACTION_NUMBERS: Record<string, number> = {
  'CREATE TABLE': 1, 'INSERT': 2, 'SELECT': 3, 'CREATE ROLE': 52,
  'ALTER ROLE': 79, 'DROP ROLE': 54, 'CREATE USER': 51, 'ALTER USER': 43,
  'DROP USER': 53, 'GRANT': 17, 'REVOKE': 18, 'CREATE VIEW': 21,
  'DROP VIEW': 22, 'CREATE INDEX': 9, 'DROP INDEX': 10, 'DROP TABLE': 12,
  'ALTER TABLE': 15, 'CREATE SEQUENCE': 13, 'DROP SEQUENCE': 14,
  'CREATE TRIGGER': 59, 'CREATE PROCEDURE': 24, 'CREATE PROFILE': 65,
  'ALTER PROFILE': 67, 'DROP PROFILE': 66,
};

registerView({
  name: 'SYS.AUD$',
  comment: 'Raw audit trail table',
  query({ catalog }) {
    return queryResult(
      [
        { name: 'SESSIONID', dataType: oracleNumber(10) },
        { name: 'USERID', dataType: oracleVarchar2(128) },
        { name: 'ACTION#', dataType: oracleNumber(10) },
        { name: 'RETURNCODE', dataType: oracleNumber(10) },
        { name: 'TIMESTAMP#', dataType: oracleDate() },
        { name: 'OBJ$NAME', dataType: oracleVarchar2(128) },
        { name: 'OBJ$CREATOR', dataType: oracleVarchar2(128) },
        { name: 'SQLTEXT', dataType: oracleVarchar2(2000) },
      ],
      catalog.getAuditTrail().map(e => [
        e.sessionId,
        e.username,
        ACTION_NUMBERS[e.actionName] ?? 0,
        e.returncode,
        e.timestamp.toISOString(),
        e.objName,
        e.objOwner,
        e.sqlText,
      ])
    );
  },
});
