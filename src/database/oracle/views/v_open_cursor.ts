/**
 * V$OPEN_CURSOR — open cursors for the current user.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$OPEN_CURSOR',
  comment: 'Open cursors',
  query({ currentUser }) {
    return queryResult(
      [
        { name: 'SID', dataType: oracleNumber(10) },
        { name: 'USER_NAME', dataType: oracleVarchar2(30) },
        { name: 'SQL_ID', dataType: oracleVarchar2(13) },
        { name: 'SQL_TEXT', dataType: oracleVarchar2(60) },
        { name: 'CURSOR_TYPE', dataType: oracleVarchar2(64) },
      ],
      [
        [10, currentUser.toUpperCase(), 'abc123def45', 'SELECT 1 FROM DUAL', 'OPEN'],
      ]
    );
  },
});
