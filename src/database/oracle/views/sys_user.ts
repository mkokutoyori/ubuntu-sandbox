/**
 * SYS.USER$ — base user table, from the catalog user registry.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';
import { deriveStoredVerifiers } from '../security/storedVerifier';

registerView({
  name: 'SYS.USER$',
  comment: 'Base user table',
  query({ catalog }) {
    return queryResult(
      [
        { name: 'USER#', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(30) },
        { name: 'TYPE#', dataType: oracleNumber(10) },
        // PASSWORD = legacy 10g hash, SPARE4 = 11g `S:` + 12c `T:` verifiers.
        { name: 'PASSWORD', dataType: oracleVarchar2(30) },
        { name: 'CTIME', dataType: oracleDate() },
        { name: 'SPARE4', dataType: oracleVarchar2(4000) },
      ],
      catalog.getAllUsers().map((u, i) => {
        const pwd = catalog.getStoredPassword(u.username);
        // Memoized — computed once when the password was set, the way real
        // Oracle stores verifiers in USER$ instead of re-deriving per query.
        const v = pwd ? deriveStoredVerifiers(u.username, pwd) : null;
        return [i + 1, u.username, 1, v?.password ?? '', u.created.toISOString(), v?.spare4 ?? ''];
      })
    );
  },
});
