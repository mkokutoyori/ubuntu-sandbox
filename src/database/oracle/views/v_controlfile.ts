/**
 * V$CONTROLFILE — control files, from the live instance parameter.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$CONTROLFILE',
  comment: 'Control files',
  query({ instance }) {
    const ctlFiles = (instance.getParameter('control_files') ?? '').split(',').map(f => f.trim());
    return queryResult(
      [
        { name: 'NAME', dataType: oracleVarchar2(513) },
        { name: 'STATUS', dataType: oracleVarchar2(7) },
      ],
      ctlFiles.map(f => [f, 'VALID'])
    );
  },
});
