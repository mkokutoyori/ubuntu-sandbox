/**
 * V$DBLINK — currently-open database links in this session. Empty
 * until a CONNECT TO over a link occurs in the session.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$DBLINK',
  comment: 'Currently-open database links',
  query() {
    return queryResult(
      [
        { name: 'DB_LINK', dataType: oracleVarchar2(128) },
        { name: 'OWNER_ID', dataType: oracleNumber(10) },
        { name: 'LOGGED_ON', dataType: oracleVarchar2(3) },
        { name: 'HETEROGENEOUS', dataType: oracleVarchar2(3) },
        { name: 'PROTOCOL', dataType: oracleVarchar2(6) },
        { name: 'OPEN_CURSORS', dataType: oracleNumber(10) },
        { name: 'IN_TRANSACTION', dataType: oracleVarchar2(3) },
        { name: 'UPDATE_SENT', dataType: oracleVarchar2(3) },
        { name: 'COMMIT_POINT_STRENGTH', dataType: oracleNumber(10) },
        { name: 'INSTANT', dataType: oracleDate() },
      ],
      []
    );
  },
});
