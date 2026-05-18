/**
 * V$SGA — SGA memory areas, from the live instance SGA info.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$SGA',
  comment: 'SGA memory areas',
  query({ instance }) {
    const sga = instance.getSGAInfo();
    return queryResult(
      [
        { name: 'NAME', dataType: oracleVarchar2(40) },
        { name: 'VALUE', dataType: oracleVarchar2(20) },
      ],
      [
        ['Total System Global Area', sga.totalSize],
        ['Fixed Size', '2M'],
        ['Variable Size', sga.sharedPool],
        ['Database Buffers', sga.bufferCache],
        ['Redo Buffers', sga.redoLogBuffer],
      ]
    );
  },
});
