/**
 * SYS.TS$ — base tablespace table, from real storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'SYS.TS$',
  comment: 'Base tablespace table',
  query({ storage }) {
    return queryResult(
      [
        { name: 'TS#', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(30) },
        { name: 'BLOCKSIZE', dataType: oracleNumber(10) },
        { name: 'STATUS$', dataType: oracleVarchar2(9) },
      ],
      storage.getAllTablespaces().map((ts, i) => [i, ts.name, ts.blockSize, 'ONLINE'])
    );
  },
});
