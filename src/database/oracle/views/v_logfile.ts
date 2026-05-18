/**
 * V$LOGFILE — redo log members, from the live instance.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$LOGFILE',
  comment: 'Redo log members',
  query({ instance }) {
    const rows: (string | number)[][] = [];
    for (const g of instance.getRedoLogGroups()) {
      for (const m of g.members) {
        rows.push([g.group, m, 'ONLINE', g.status]);
      }
    }
    return queryResult(
      [
        { name: 'GROUP#', dataType: oracleNumber(10) },
        { name: 'MEMBER', dataType: oracleVarchar2(513) },
        { name: 'TYPE', dataType: oracleVarchar2(7) },
        { name: 'STATUS', dataType: oracleVarchar2(16) },
      ],
      rows
    );
  },
});
