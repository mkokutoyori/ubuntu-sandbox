/**
 * DBA_TABLESPACES — tablespaces, from real storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_TABLESPACES',
  comment: 'Tablespaces',
  query({ storage }) {
    return queryResult(
      [
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
        { name: 'STATUS', dataType: oracleVarchar2(9) },
        { name: 'CONTENTS', dataType: oracleVarchar2(9) },
        { name: 'BLOCK_SIZE', dataType: oracleNumber(10) },
      ],
      storage.getAllTablespaces().map(ts => [ts.name, ts.status, ts.type, ts.blockSize])
    );
  },
});
