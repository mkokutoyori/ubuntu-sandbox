/**
 * V$TABLESPACE — tablespace identity, from real storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$TABLESPACE',
  comment: 'Tablespace information',
  query({ storage }) {
    return queryResult(
      [
        { name: 'TS#', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(30) },
        { name: 'INCLUDED_IN_DATABASE_BACKUP', dataType: oracleVarchar2(3) },
        { name: 'BIGFILE', dataType: oracleVarchar2(3) },
        { name: 'FLASHBACK_ON', dataType: oracleVarchar2(3) },
        { name: 'ENCRYPT_IN_BACKUP', dataType: oracleVarchar2(3) },
        { name: 'BLOCK_SIZE', dataType: oracleNumber(10) },
        { name: 'CON_ID', dataType: oracleNumber(10) },
      ],
      storage.getAllTablespaces().map((ts, i) => [
        i, ts.name, 'YES', 'NO', 'YES', 'NO', ts.blockSize, 0,
      ])
    );
  },
});
