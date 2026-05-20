/**
 * DBA_INDEXES — indexes, from real storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_INDEXES',
  comment: 'Indexes',
  query({ storage }) {
    const rows: (string | number)[][] = [];
    for (const schema of storage.getSchemas()) {
      for (const idx of storage.getIndexes(schema)) {
        const isFunctionBased = idx.expressions?.some(e => e !== null) ?? false;
        // 19c index types: NORMAL, BITMAP, NORMAL/REV (descending), FUNCTION-BASED NORMAL / BITMAP, IOT - TOP, CLUSTER.
        const indexType = idx.bitmap
          ? (isFunctionBased ? 'FUNCTION-BASED BITMAP' : 'BITMAP')
          : (isFunctionBased ? 'FUNCTION-BASED NORMAL' : 'NORMAL');
        rows.push([schema, idx.name, idx.tableName, idx.unique ? 'UNIQUE' : 'NONUNIQUE', 'VALID', indexType]);
      }
    }
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'INDEX_NAME', dataType: oracleVarchar2(30) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'UNIQUENESS', dataType: oracleVarchar2(9) },
        { name: 'STATUS', dataType: oracleVarchar2(8) },
        { name: 'INDEX_TYPE', dataType: oracleVarchar2(27) },
      ],
      rows
    );
  },
});
