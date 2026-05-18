/**
 * SYS.OBJ$ — base object table (tables, indexes, views), from storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'SYS.OBJ$',
  comment: 'Base object table',
  query({ storage }) {
    const rows: (string | number | null)[][] = [];
    let objId = 1000;
    for (const t of storage.getAllTables()) {
      rows.push([objId++, t.schema, t.name, 2, 'TABLE', 'VALID', new Date().toISOString()]);
    }
    for (const schema of storage.getSchemas()) {
      for (const idx of storage.getIndexes(schema)) {
        rows.push([objId++, schema, idx.name, 1, 'INDEX', 'VALID', new Date().toISOString()]);
      }
    }
    for (const v of storage.getAllViews()) {
      rows.push([objId++, v.schema, v.name, 4, 'VIEW', 'VALID', new Date().toISOString()]);
    }
    return queryResult(
      [
        { name: 'OBJ#', dataType: oracleNumber(10) },
        { name: 'OWNER#', dataType: oracleVarchar2(30) },
        { name: 'NAME', dataType: oracleVarchar2(128) },
        { name: 'NAMESPACE', dataType: oracleNumber(10) },
        { name: 'TYPE#', dataType: oracleVarchar2(13) },
        { name: 'STATUS', dataType: oracleVarchar2(7) },
        { name: 'CTIME', dataType: oracleDate() },
      ],
      rows
    );
  },
});
