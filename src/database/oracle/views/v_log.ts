/**
 * V$LOG — online redo log groups, from the live instance.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$LOG',
  comment: 'Online redo log groups',
  query({ instance }) {
    return queryResult(
      [
        { name: 'GROUP#', dataType: oracleNumber(10) },
        { name: 'BYTES', dataType: oracleNumber(20) },
        { name: 'MEMBERS', dataType: oracleNumber(10) },
        { name: 'STATUS', dataType: oracleVarchar2(16) },
        { name: 'SEQUENCE#', dataType: oracleNumber(10) },
      ],
      instance.getRedoLogGroups().map(g => [g.group, g.sizeBytes, g.members.length, g.status, g.sequence])
    );
  },
});
