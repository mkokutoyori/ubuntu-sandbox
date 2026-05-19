/**
 * V$ROLLSTAT — rollback segment statistics. Derived from the rollback
 * segments tracked in storage (one row per active segment, but the
 * simulator does not allocate them, so empty for now).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$ROLLSTAT',
  comment: 'Rollback segment statistics',
  query() {
    return queryResult(
      [
        { name: 'USN', dataType: oracleNumber(10) },
        { name: 'EXTENTS', dataType: oracleNumber(10) },
        { name: 'RSSIZE', dataType: oracleNumber(20) },
        { name: 'WRITES', dataType: oracleNumber(20) },
        { name: 'XACTS', dataType: oracleNumber(10) },
        { name: 'STATUS', dataType: oracleNumber(10) },
      ],
      []
    );
  },
});
