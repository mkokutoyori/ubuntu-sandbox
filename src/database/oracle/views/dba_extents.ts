/**
 * DBA_EXTENTS — data extents (one per table), from real storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_EXTENTS',
  comment: 'Data extents',
  query({ storage }) {
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'SEGMENT_NAME', dataType: oracleVarchar2(30) },
        { name: 'SEGMENT_TYPE', dataType: oracleVarchar2(18) },
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
        { name: 'EXTENT_ID', dataType: oracleNumber(10) },
        { name: 'BYTES', dataType: oracleNumber(20) },
        { name: 'BLOCKS', dataType: oracleNumber(20) },
      ],
      storage.getAllTables().map(t => [t.schema, t.name, 'TABLE', t.tablespace ?? 'USERS', 0, 65536, 8])
    );
  },
});
