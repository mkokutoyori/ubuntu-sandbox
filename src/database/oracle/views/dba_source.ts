/**
 * DBA_SOURCE — PL/SQL unit source lines, from the stored-units provider.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_SOURCE',
  comment: 'PL/SQL source code',
  query({ catalog }) {
    const rows: (string | number)[][] = [];
    for (const u of catalog.getStoredUnits()) {
      for (let i = 0; i < u.sourceLines.length; i++) {
        rows.push([u.schema, u.name, u.type, i + 1, u.sourceLines[i]]);
      }
    }
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'NAME', dataType: oracleVarchar2(30) },
        { name: 'TYPE', dataType: oracleVarchar2(12) },
        { name: 'LINE', dataType: oracleNumber(10) },
        { name: 'TEXT', dataType: oracleVarchar2(4000) },
      ],
      rows
    );
  },
});
