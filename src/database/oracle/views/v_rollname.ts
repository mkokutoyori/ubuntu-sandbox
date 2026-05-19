/**
 * V$ROLLNAME — names of currently online rollback segments. Empty in
 * the simulator (UNDO management replaces classic rollback segments).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$ROLLNAME',
  comment: 'Names of online rollback segments',
  query() {
    return queryResult(
      [
        { name: 'USN', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(30) },
      ],
      []
    );
  },
});
