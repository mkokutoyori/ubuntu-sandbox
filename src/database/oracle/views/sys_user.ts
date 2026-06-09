/**
 * SYS.USER$ — base user table, from the catalog user registry.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'SYS.USER$',
  comment: 'Base user table',
  query({ catalog }) {
    return queryResult(
      [
        { name: 'USER#', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(30) },
        { name: 'TYPE#', dataType: oracleNumber(10) },
        { name: 'PASSWORD', dataType: oracleVarchar2(30) },
        { name: 'CTIME', dataType: oracleDate() },
        { name: 'SPARE4', dataType: oracleVarchar2(4000) },
      ],
      catalog.getAllUsers().map((u, i) => {
        const v = catalog.getStoredVerifiers(u.username);
        return [i + 1, u.username, 1, v?.password ?? '', u.created.toISOString(), v?.spare4 ?? ''];
      })
    );
  },
});
