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
        { name: 'BIGFILE', dataType: oracleVarchar2(3) },
        { name: 'BLOCK_SIZE', dataType: oracleNumber(10) },
      ],
      storage.getAllTablespaces().map((ts, i) => [i, ts.name, 'NO', ts.blockSize])
    );
  },
});
