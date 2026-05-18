/**
 * DBA_SYNONYMS — synonyms, from real storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_SYNONYMS',
  comment: 'Synonyms',
  query({ storage }) {
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'SYNONYM_NAME', dataType: oracleVarchar2(30) },
        { name: 'TABLE_OWNER', dataType: oracleVarchar2(30) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'DB_LINK', dataType: oracleVarchar2(128) },
      ],
      storage.getAllSynonyms().map(s => [s.owner, s.name, s.tableOwner, s.tableName, s.dbLink ?? null])
    );
  },
});
