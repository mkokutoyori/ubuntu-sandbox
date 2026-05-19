/**
 * DBA_LOBS — LOB column metadata. Returns empty until the storage
 * layer tracks LOB columns explicitly (no fabricated rows).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_LOBS',
  comment: 'LOB columns',
  query() {
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'COLUMN_NAME', dataType: oracleVarchar2(30) },
        { name: 'SEGMENT_NAME', dataType: oracleVarchar2(30) },
        { name: 'INDEX_NAME', dataType: oracleVarchar2(30) },
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
        { name: 'CHUNK', dataType: oracleNumber(10) },
        { name: 'PCTVERSION', dataType: oracleNumber(10) },
        { name: 'RETENTION', dataType: oracleNumber(10) },
        { name: 'CACHE', dataType: oracleVarchar2(10) },
        { name: 'LOGGING', dataType: oracleVarchar2(7) },
        { name: 'ENCRYPT', dataType: oracleVarchar2(4) },
        { name: 'SECUREFILE', dataType: oracleVarchar2(3) },
        { name: 'DEDUPLICATION', dataType: oracleVarchar2(15) },
        { name: 'COMPRESSION', dataType: oracleVarchar2(6) },
        { name: 'IN_ROW', dataType: oracleVarchar2(3) },
        { name: 'PARTITIONED', dataType: oracleVarchar2(3) },
      ],
      []
    );
  },
});
