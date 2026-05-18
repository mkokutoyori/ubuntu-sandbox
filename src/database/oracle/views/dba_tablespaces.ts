/**
 * DBA_TABLESPACES — tablespaces, from real storage.
 *
 * Exposes the columns most DBA scripts read: LOGGING, EXTENT_MANAGEMENT,
 * SEGMENT_SPACE_MANAGEMENT, ALLOCATION_TYPE, INITIAL_EXTENT, NEXT_EXTENT.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_TABLESPACES',
  comment: 'Tablespaces',
  query({ storage }) {
    return queryResult(
      [
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
        { name: 'STATUS', dataType: oracleVarchar2(9) },
        { name: 'CONTENTS', dataType: oracleVarchar2(9) },
        { name: 'BLOCK_SIZE', dataType: oracleNumber(10) },
        { name: 'INITIAL_EXTENT', dataType: oracleNumber(20) },
        { name: 'NEXT_EXTENT', dataType: oracleNumber(20) },
        { name: 'MIN_EXTENTS', dataType: oracleNumber(10) },
        { name: 'MAX_EXTENTS', dataType: oracleNumber(10) },
        { name: 'MAX_SIZE', dataType: oracleNumber(20) },
        { name: 'PCT_INCREASE', dataType: oracleNumber(10) },
        { name: 'MIN_EXTLEN', dataType: oracleNumber(20) },
        { name: 'LOGGING', dataType: oracleVarchar2(9) },
        { name: 'FORCE_LOGGING', dataType: oracleVarchar2(3) },
        { name: 'EXTENT_MANAGEMENT', dataType: oracleVarchar2(10) },
        { name: 'ALLOCATION_TYPE', dataType: oracleVarchar2(9) },
        { name: 'SEGMENT_SPACE_MANAGEMENT', dataType: oracleVarchar2(6) },
        { name: 'BIGFILE', dataType: oracleVarchar2(3) },
        { name: 'ENCRYPTED', dataType: oracleVarchar2(3) },
      ],
      storage.getAllTablespaces().map(ts => [
        ts.name, ts.status, ts.type, ts.blockSize,
        65536, 1048576, 1, 2147483645, 2147483645, 0, 65536,
        'LOGGING', 'NO',
        'LOCAL', 'SYSTEM', 'AUTO',
        'NO', 'NO',
      ])
    );
  },
});
