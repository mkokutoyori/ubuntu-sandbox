/**
 * DBA_TABLES — relational tables, from real storage.
 * Exposes the volumetric columns DBA scripts read (BLOCKS, EMPTY_BLOCKS,
 * AVG_SPACE, AVG_ROW_LEN, …) computed from rowCount with stub heuristics.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

const SEED_TIME = new Date('2026-01-01T00:00:00Z');

registerView({
  name: 'DBA_TABLES',
  comment: 'Database tables',
  query({ storage }) {
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
        { name: 'NUM_ROWS', dataType: oracleNumber(20) },
        { name: 'BLOCKS', dataType: oracleNumber(20) },
        { name: 'EMPTY_BLOCKS', dataType: oracleNumber(20) },
        { name: 'AVG_SPACE', dataType: oracleNumber(10) },
        { name: 'AVG_ROW_LEN', dataType: oracleNumber(10) },
        { name: 'CHAIN_CNT', dataType: oracleNumber(20) },
        { name: 'LAST_ANALYZED', dataType: oracleDate() },
        { name: 'LOGGING', dataType: oracleVarchar2(3) },
        { name: 'PARTITIONED', dataType: oracleVarchar2(3) },
        { name: 'TEMPORARY', dataType: oracleVarchar2(1) },
        { name: 'STATUS', dataType: oracleVarchar2(8) },
      ],
      storage.getAllTables().map(t => {
        const blocks = Math.max(1, Math.ceil(t.rowCount * 200 / 8192));
        return [
          t.schema, t.name, t.tablespace ?? 'USERS', t.rowCount,
          blocks, Math.max(0, blocks - 1),
          1000, 200,
          0,                  // CHAIN_CNT
          SEED_TIME,
          'YES',
          t.partitioning ? 'YES' : 'NO',
          'N',
          'VALID',
        ];
      })
    );
  },
});
