/**
 * V$SGASTAT — detailed SGA pool statistics.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$SGASTAT',
  comment: 'SGA detailed statistics',
  query() {
    return queryResult(
      [
        { name: 'POOL', dataType: oracleVarchar2(26) },
        { name: 'NAME', dataType: oracleVarchar2(64) },
        { name: 'BYTES', dataType: oracleNumber(20) },
      ],
      [
        ['shared pool', 'library cache', 64 * 1024 * 1024],
        ['shared pool', 'dictionary cache', 32 * 1024 * 1024],
        ['shared pool', 'sql area', 48 * 1024 * 1024],
        ['shared pool', 'free memory', 16 * 1024 * 1024],
        ['java pool', 'free memory', 16 * 1024 * 1024],
        ['large pool', 'free memory', 16 * 1024 * 1024],
        [null, 'buffer_cache', 128 * 1024 * 1024],
        [null, 'log_buffer', 8 * 1024 * 1024],
        [null, 'fixed_sga', 2 * 1024 * 1024],
      ]
    );
  },
});
