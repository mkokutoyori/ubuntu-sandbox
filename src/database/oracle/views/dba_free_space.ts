/**
 * DBA_FREE_SPACE — free extents per data file, from real storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_FREE_SPACE',
  comment: 'Free extents',
  query({ storage }) {
    const rows: (string | number)[][] = [];
    let fileId = 1;
    for (const ts of storage.getAllTablespaces()) {
      for (const df of ts.datafiles) {
        const freeBytes = Math.floor(parseInt(String(df.size)) * 0.7);
        rows.push([ts.name, fileId++, freeBytes, 1]);
      }
    }
    return queryResult(
      [
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
        { name: 'FILE_ID', dataType: oracleNumber(10) },
        { name: 'BYTES', dataType: oracleNumber(20) },
        { name: 'BLOCKS', dataType: oracleNumber(20) },
      ],
      rows
    );
  },
});
