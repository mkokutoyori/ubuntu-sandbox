/**
 * DBA_TABLESPACES — tablespaces, every column derived from the
 * TablespaceMeta now carried by the storage layer (no fabricated
 * LOGGING / EXTENT_MANAGEMENT defaults that ignore the actual DDL).
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
        { name: 'MIN_EXTLEN', dataType: oracleNumber(20) },
        { name: 'LOGGING', dataType: oracleVarchar2(9) },
        { name: 'FORCE_LOGGING', dataType: oracleVarchar2(3) },
        { name: 'EXTENT_MANAGEMENT', dataType: oracleVarchar2(10) },
        { name: 'ALLOCATION_TYPE', dataType: oracleVarchar2(9) },
        { name: 'SEGMENT_SPACE_MANAGEMENT', dataType: oracleVarchar2(6) },
        { name: 'BIGFILE', dataType: oracleVarchar2(3) },
        { name: 'ENCRYPTED', dataType: oracleVarchar2(3) },
        { name: 'FLASHBACK_ON', dataType: oracleVarchar2(3) },
        { name: 'DEF_TAB_COMPRESSION', dataType: oracleVarchar2(8) },
        { name: 'RETENTION', dataType: oracleVarchar2(11) },
      ],
      storage.getAllTablespaces().map(ts => [
        ts.name, ts.status, ts.type, ts.blockSize,
        ts.initialExtent, ts.nextExtent, ts.minExtentLength,
        ts.logging ? 'LOGGING' : 'NOLOGGING',
        ts.forceLogging ? 'YES' : 'NO',
        ts.extentManagement,
        ts.allocationType,
        ts.segmentSpaceManagement,
        ts.bigfile ? 'YES' : 'NO',
        ts.encrypted ? 'YES' : 'NO',
        ts.flashbackOn ? 'YES' : 'NO',
        'DISABLED', // DEF_TAB_COMPRESSION
        ts.type === 'UNDO' ? 'NOGUARANTEE' : 'NOT APPLY', // RETENTION
      ])
    );
  },
});
