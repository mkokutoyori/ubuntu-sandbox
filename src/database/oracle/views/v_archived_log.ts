/**
 * V$ARCHIVED_LOG — archived redo logs (only when archivelog mode is on).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$ARCHIVED_LOG',
  comment: 'Archived log information',
  query({ instance }) {
    return queryResult(
      [
        { name: 'RECID', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(513) },
        { name: 'SEQUENCE#', dataType: oracleNumber(10) },
        { name: 'FIRST_TIME', dataType: oracleDate() },
        { name: 'NEXT_TIME', dataType: oracleDate() },
        { name: 'ARCHIVED', dataType: oracleVarchar2(3) },
        { name: 'DELETED', dataType: oracleVarchar2(3) },
        { name: 'STATUS', dataType: oracleVarchar2(1) },
      ],
      instance.archiveLogMode ? [
        [1, '/u01/app/oracle/fast_recovery_area/ORCL/archivelog/arc_0001.arc', 1, new Date().toISOString(), new Date().toISOString(), 'YES', 'NO', 'A'],
      ] : []
    );
  },
});
