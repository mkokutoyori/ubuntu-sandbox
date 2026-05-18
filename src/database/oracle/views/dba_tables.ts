/**
 * DBA_TABLES — relational tables, from real storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

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
        { name: 'STATUS', dataType: oracleVarchar2(8) },
      ],
      storage.getAllTables().map(t => [t.schema, t.name, t.tablespace ?? 'USERS', t.rowCount, 'VALID'])
    );
  },
});
