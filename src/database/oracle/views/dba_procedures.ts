/**
 * DBA_PROCEDURES — stored procedures/functions, from the stored-units
 * provider.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_PROCEDURES',
  comment: 'Stored procedures and functions',
  query({ catalog }) {
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'OBJECT_NAME', dataType: oracleVarchar2(30) },
        { name: 'OBJECT_TYPE', dataType: oracleVarchar2(13) },
        { name: 'AGGREGATE', dataType: oracleVarchar2(3) },
        { name: 'PIPELINED', dataType: oracleVarchar2(3) },
        { name: 'DETERMINISTIC', dataType: oracleVarchar2(3) },
      ],
      catalog.getStoredUnits()
        .filter(u => u.type === 'PROCEDURE' || u.type === 'FUNCTION')
        .map(u => [u.schema, u.name, u.type, 'NO', 'NO', 'NO'])
    );
  },
});
