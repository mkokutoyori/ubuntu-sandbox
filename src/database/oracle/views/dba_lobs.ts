/**
 * DBA_LOBS — every LOB / CLOB / NCLOB / BLOB / BFILE column in the
 * catalog. Rows derive directly from the real column types stored on
 * each table — no fabricated data, no separate LOB registry.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

const LOB_TYPES = new Set(['CLOB', 'NCLOB', 'BLOB', 'BFILE']);

registerView({
  name: 'DBA_LOBS',
  comment: 'LOB columns',
  query({ storage }) {
    const rows: (string | number)[][] = [];
    for (const t of storage.getAllTables()) {
      for (const c of t.columns) {
        const typeName = (c.dataType.name ?? '').toUpperCase();
        if (!LOB_TYPES.has(typeName)) continue;
        const segName = `SYS_LOB_${t.schema}_${t.name}_${c.name}`.toUpperCase();
        rows.push([
          t.schema,
          t.name,
          c.name,
          segName,
          `SYS_IL_${t.schema}_${t.name}_${c.name}`.toUpperCase(),
          t.tablespace ?? 'USERS',
          8192,                // CHUNK
          10,                  // PCTVERSION
          0,                   // RETENTION
          'YES',               // CACHE
          'YES',               // LOGGING
          'NO',                // ENCRYPT
          'YES',               // SECUREFILE
          'NO',                // DEDUPLICATION
          'NO',                // COMPRESSION
          'YES',               // IN_ROW
          'NO',                // PARTITIONED
        ]);
      }
    }
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
      rows,
    );
  },
});
