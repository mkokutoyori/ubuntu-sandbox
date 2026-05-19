/**
 * DBA_LOB_SUBPARTITIONS — LOB column subpartition metadata. Empty
 * until the storage layer tracks composite-partitioned LOBs.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_LOB_SUBPARTITIONS',
  comment: 'LOB column subpartitions',
  query() {
    return queryResult(
      [
        { name: 'TABLE_OWNER', dataType: oracleVarchar2(30) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'COLUMN_NAME', dataType: oracleVarchar2(30) },
        { name: 'LOB_NAME', dataType: oracleVarchar2(30) },
        { name: 'LOB_PARTITION_NAME', dataType: oracleVarchar2(30) },
        { name: 'SUBPARTITION_NAME', dataType: oracleVarchar2(30) },
        { name: 'LOB_SUBPARTITION_NAME', dataType: oracleVarchar2(30) },
        { name: 'SUBPARTITION_POSITION', dataType: oracleNumber(10) },
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
      ],
      []
    );
  },
});
