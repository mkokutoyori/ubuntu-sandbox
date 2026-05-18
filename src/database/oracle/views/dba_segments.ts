/**
 * DBA_SEGMENTS — storage segments (one per table), from real storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_SEGMENTS',
  comment: 'Storage segments',
  query({ storage }) {
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'SEGMENT_NAME', dataType: oracleVarchar2(30) },
        { name: 'SEGMENT_TYPE', dataType: oracleVarchar2(18) },
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
        { name: 'BYTES', dataType: oracleNumber(20) },
        { name: 'BLOCKS', dataType: oracleNumber(20) },
        { name: 'EXTENTS', dataType: oracleNumber(10) },
      ],
      storage.getAllTables().map(t => [t.schema, t.name, 'TABLE', t.tablespace ?? 'USERS', t.rowCount * 200, Math.ceil(t.rowCount * 200 / 8192), 1])
    );
  },
});
