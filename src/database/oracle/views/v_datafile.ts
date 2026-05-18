/**
 * V$DATAFILE — data files per tablespace, from real storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$DATAFILE',
  comment: 'Data file information',
  query({ storage }) {
    const rows: (string | number | null)[][] = [];
    let fileNum = 1;
    for (const ts of storage.getAllTablespaces()) {
      for (const df of ts.datafiles) {
        rows.push([fileNum++, df.path, ts.name, df.size, df.autoextend ? 'YES' : 'NO']);
      }
    }
    return queryResult(
      [
        { name: 'FILE#', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(513) },
        { name: 'TS#_NAME', dataType: oracleVarchar2(30) },
        { name: 'BYTES', dataType: oracleVarchar2(20) },
        { name: 'AUTOEXTENSIBLE', dataType: oracleVarchar2(3) },
      ],
      rows
    );
  },
});
