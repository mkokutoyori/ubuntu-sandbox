/**
 * V$IOSTAT_FUNCTION — per-function I/O stats.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$IOSTAT_FUNCTION',
  comment: 'Per-function I/O statistics',
  query() {
    // No per-function I/O accounting in the simulator — empty is the
    // truthful answer (rather than a fabricated row per function).
    return queryResult(
      [
        { name: 'FUNCTION_ID', dataType: oracleNumber(10) },
        { name: 'FUNCTION_NAME', dataType: oracleVarchar2(30) },
        { name: 'SMALL_READ_MEGABYTES', dataType: oracleNumber(20) },
        { name: 'SMALL_WRITE_MEGABYTES', dataType: oracleNumber(20) },
        { name: 'LARGE_READ_MEGABYTES', dataType: oracleNumber(20) },
        { name: 'LARGE_WRITE_MEGABYTES', dataType: oracleNumber(20) },
        { name: 'SMALL_READ_REQS', dataType: oracleNumber(20) },
        { name: 'SMALL_WRITE_REQS', dataType: oracleNumber(20) },
      ],
      []
    );
  },
});
