/**
 * V$BACKUP — per-datafile online backup status, from real storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$BACKUP',
  comment: 'Online backup status',
  query({ storage }) {
    const rows: (string | number | null)[][] = [];
    let fileNum = 1;
    for (const ts of storage.getAllTablespaces()) {
      for (const _df of ts.datafiles) {
        rows.push([fileNum++, 'NOT ACTIVE', 0, null, null]);
      }
    }
    return queryResult(
      [
        { name: 'FILE#', dataType: oracleNumber(10) },
        { name: 'STATUS', dataType: oracleVarchar2(18) },
        { name: 'CHANGE#', dataType: oracleNumber(20) },
        { name: 'TIME', dataType: oracleDate() },
        { name: 'COMPLETION_TIME', dataType: oracleDate() },
      ],
      rows
    );
  },
});
