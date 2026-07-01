/**
 * DBA_SEGMENTS — storage segments (one per table), from real storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';
import { ROW_FOOTPRINT_BYTES } from './_fileSize';

registerView({
  name: 'DBA_SEGMENTS',
  comment: 'Storage segments',
  query({ storage }) {
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'SEGMENT_NAME', dataType: oracleVarchar2(30) },
        { name: 'PARTITION_NAME', dataType: oracleVarchar2(30) },
        { name: 'SEGMENT_TYPE', dataType: oracleVarchar2(18) },
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
        { name: 'BYTES', dataType: oracleNumber(20) },
        { name: 'BLOCKS', dataType: oracleNumber(20) },
        { name: 'EXTENTS', dataType: oracleNumber(10) },
        { name: 'INITIAL_EXTENT', dataType: oracleNumber(20) },
        { name: 'NEXT_EXTENT', dataType: oracleNumber(20) },
        { name: 'MIN_EXTENTS', dataType: oracleNumber(10) },
        { name: 'MAX_EXTENTS', dataType: oracleNumber(10) },
        { name: 'PCT_INCREASE', dataType: oracleNumber(10) },
        { name: 'BUFFER_POOL', dataType: oracleVarchar2(7) },
      ],
      storage.getAllTables().map(t => [
        t.schema, t.name, null, 'TABLE', t.tablespace ?? 'USERS',
        t.rowCount * ROW_FOOTPRINT_BYTES, Math.ceil(t.rowCount * ROW_FOOTPRINT_BYTES / 8192), 1,
        65536, 1048576, 1, 2147483645, 0, 'DEFAULT',
      ])
    );
  },
});
