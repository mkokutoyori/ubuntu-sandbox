/**
 * V$SESSTAT — per-session statistics (representative counters).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$SESSTAT',
  comment: 'Session statistics',
  query() {
    return queryResult(
      [
        { name: 'SID', dataType: oracleNumber(10) },
        { name: 'STATISTIC#', dataType: oracleNumber(10) },
        { name: 'VALUE', dataType: oracleNumber(20) },
      ],
      [
        [10, 0, 1],
        [10, 4, 0],
        [10, 5, 0],
        [10, 6, 1],
        [10, 8, 50],
      ]
    );
  },
});
