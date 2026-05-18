/**
 * DBA_DATA_FILES — permanent data files, from real storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_DATA_FILES',
  comment: 'Data files',
  query({ storage }) {
    const rows: (string | number)[][] = [];
    let fileId = 1;
    for (const ts of storage.getAllTablespaces()) {
      if (ts.type === 'TEMPORARY') continue;
      for (const df of ts.datafiles) {
        rows.push([fileId++, df.path, ts.name, df.size, df.autoextend ? 'YES' : 'NO']);
      }
    }
    return queryResult(
      [
        { name: 'FILE_ID', dataType: oracleNumber(10) },
        { name: 'FILE_NAME', dataType: oracleVarchar2(513) },
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
        { name: 'BYTES', dataType: oracleVarchar2(20) },
        { name: 'AUTOEXTENSIBLE', dataType: oracleVarchar2(3) },
      ],
      rows
    );
  },
});
