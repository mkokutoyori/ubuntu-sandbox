/**
 * DBA_DB_LINKS — database links. None in the simulator.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_DB_LINKS',
  comment: 'Database links',
  query() {
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'DB_LINK', dataType: oracleVarchar2(128) },
        { name: 'USERNAME', dataType: oracleVarchar2(30) },
        { name: 'HOST', dataType: oracleVarchar2(2000) },
        { name: 'CREATED', dataType: oracleDate() },
      ],
      []
    );
  },
});
