/**
 * SYS.COL$ — base column metadata, from real storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'SYS.COL$',
  comment: 'Base column metadata',
  query({ storage }) {
    const rows: (string | number | null)[][] = [];
    let objId = 1000;
    for (const t of storage.getAllTables()) {
      for (const c of t.columns) {
        rows.push([objId, c.name, c.ordinalPosition + 1, c.dataType.name, c.dataType.precision ?? null, c.dataType.scale ?? null, c.dataType.nullable ? 'Y' : 'N']);
      }
      objId++;
    }
    return queryResult(
      [
        { name: 'OBJ#', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(128) },
        { name: 'COL#', dataType: oracleNumber(10) },
        { name: 'TYPE#', dataType: oracleVarchar2(30) },
        { name: 'LENGTH', dataType: oracleNumber(10) },
        { name: 'SCALE', dataType: oracleNumber(10) },
        { name: 'NULL$', dataType: oracleVarchar2(1) },
      ],
      rows
    );
  },
});
