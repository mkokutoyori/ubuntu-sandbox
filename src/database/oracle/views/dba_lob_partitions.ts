/**
 * DBA_LOB_PARTITIONS — LOB column partition metadata. Empty until the
 * storage layer tracks partitioned LOBs.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_LOB_PARTITIONS',
  comment: 'LOB column partitions',
  query() {
    return queryResult(
      [
        { name: 'TABLE_OWNER', dataType: oracleVarchar2(30) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'COLUMN_NAME', dataType: oracleVarchar2(30) },
        { name: 'LOB_NAME', dataType: oracleVarchar2(30) },
        { name: 'PARTITION_NAME', dataType: oracleVarchar2(30) },
        { name: 'LOB_PARTITION_NAME', dataType: oracleVarchar2(30) },
        { name: 'PARTITION_POSITION', dataType: oracleNumber(10) },
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
        { name: 'COMPRESSION', dataType: oracleVarchar2(6) },
      ],
      []
    );
  },
});
