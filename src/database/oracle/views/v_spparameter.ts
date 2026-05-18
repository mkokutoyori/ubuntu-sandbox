/**
 * V$SPPARAMETER — SPFILE parameter values, from the live instance.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';
import { paramType } from './_params';

registerView({
  name: 'V$SPPARAMETER',
  comment: 'SPFILE parameters',
  query({ instance }) {
    const params = instance.getSpfileParameters();
    return queryResult(
      [
        { name: 'SID', dataType: oracleVarchar2(80) },
        { name: 'NAME', dataType: oracleVarchar2(80) },
        { name: 'TYPE', dataType: { name: 'NUMBER', nullable: true } },
        { name: 'VALUE', dataType: oracleVarchar2(512) },
        { name: 'DISPLAY_VALUE', dataType: oracleVarchar2(512) },
        { name: 'ISSPECIFIED', dataType: oracleVarchar2(9) },
      ],
      Array.from(params.entries()).map(([name, value]) => {
        const type = paramType(value);
        return ['*', name, type, value, value, 'TRUE'];
      })
    );
  },
});
