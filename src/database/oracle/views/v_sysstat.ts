/**
 * V$SYSSTAT — system statistics (representative counters).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$SYSSTAT',
  comment: 'System statistics',
  query() {
    return queryResult(
      [
        { name: 'STATISTIC#', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(64) },
        { name: 'CLASS', dataType: oracleNumber(10) },
        { name: 'VALUE', dataType: oracleNumber(20) },
      ],
      [
        [0, 'logons cumulative', 1, 5],
        [1, 'logons current', 1, 1],
        [2, 'opened cursors cumulative', 1, 10],
        [3, 'opened cursors current', 1, 1],
        [4, 'user commits', 1, 0],
        [5, 'user rollbacks', 1, 0],
        [6, 'user calls', 1, 1],
        [7, 'recursive calls', 1, 100],
        [8, 'session logical reads', 1, 500],
        [9, 'physical reads', 1, 10],
        [10, 'physical writes', 1, 5],
        [11, 'redo size', 1, 1024],
        [12, 'sorts (memory)', 1, 10],
        [13, 'sorts (disk)', 1, 0],
        [14, 'table scan rows gotten', 1, 200],
        [15, 'table scans (short tables)', 1, 5],
        [16, 'parse count (total)', 1, 15],
        [17, 'parse count (hard)', 1, 5],
        [18, 'execute count', 1, 20],
        [19, 'bytes sent via SQL*Net to client', 1, 4096],
        [20, 'bytes received via SQL*Net from client', 1, 2048],
      ]
    );
  },
});
