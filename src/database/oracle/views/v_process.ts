/**
 * V$PROCESS — background/server processes, from the live instance.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$PROCESS',
  comment: 'Background and server processes',
  query({ instance }) {
    return queryResult(
      [
        { name: 'SPID', dataType: oracleNumber(10) },
        { name: 'PNAME', dataType: oracleVarchar2(5) },
        { name: 'DESCRIPTION', dataType: oracleVarchar2(64) },
      ],
      instance.getBackgroundProcesses().map(p => [p.pid, p.name, p.description])
    );
  },
});
