/**
 * DBA_DB_LINKS — database links, read from the live catalog registry
 * (CREATE [PUBLIC] DATABASE LINK registers there, DROP removes).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_DB_LINKS',
  comment: 'Database links',
  query({ catalog }) {
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'DB_LINK', dataType: oracleVarchar2(128) },
        { name: 'USERNAME', dataType: oracleVarchar2(30) },
        { name: 'HOST', dataType: oracleVarchar2(2000) },
        { name: 'CREATED', dataType: oracleDate() },
      ],
      catalog.getDbLinks().map(l => [l.owner, l.name, l.username, l.host, l.created]),
    );
  },
});
