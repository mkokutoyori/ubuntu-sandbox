/**
 * V$UNDOSTAT — per-snapshot undo statistics. The simulator does not
 * track undo retention granularly, so the view is empty until the
 * runtime layer accumulates per-snapshot rows.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$UNDOSTAT',
  comment: 'Undo segment statistics',
  query() {
    return queryResult(
      [
        { name: 'BEGIN_TIME', dataType: oracleDate() },
        { name: 'END_TIME', dataType: oracleDate() },
        { name: 'UNDOTSN', dataType: oracleNumber(10) },
        { name: 'UNDOBLKS', dataType: oracleNumber(20) },
        { name: 'TXNCOUNT', dataType: oracleNumber(20) },
        { name: 'MAXCONCURRENCY', dataType: oracleNumber(10) },
        { name: 'MAXQUERYLEN', dataType: oracleNumber(10) },
        { name: 'TUNED_UNDORETENTION', dataType: oracleNumber(10) },
      ],
      []
    );
  },
});
