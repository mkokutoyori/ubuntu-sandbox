/**
 * V$ARCHIVED_LOG — archived redo logs derived from the runtime state
 * (one row per `oracle.archive-log.created` event, no rows when
 * NOARCHIVELOG).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$ARCHIVED_LOG',
  comment: 'Archived log information',
  query({ instance, runtime }) {
    if (!instance.archiveLogMode) {
      return queryResult(columns(), []);
    }
    return queryResult(
      columns(),
      runtime.archivedLogs.map((l, idx) => [
        l.recid,
        l.name,
        1,                   // THREAD#
        l.sequence,
        1,                   // RESETLOGS_ID
        new Date(l.firstTime),
        100 + idx,           // FIRST_CHANGE#
        100 + idx + 1,       // NEXT_CHANGE#
        new Date(l.firstTime),
        'YES',
        'NO',
        'A',
        Math.round(l.sizeBytes / 512),
        512,
      ])
    );
  },
});

function columns() {
  return [
    { name: 'RECID', dataType: oracleNumber(10) },
    { name: 'NAME', dataType: oracleVarchar2(513) },
    { name: 'THREAD#', dataType: oracleNumber(10) },
    { name: 'SEQUENCE#', dataType: oracleNumber(10) },
    { name: 'RESETLOGS_ID', dataType: oracleNumber(10) },
    { name: 'FIRST_TIME', dataType: oracleDate() },
    { name: 'FIRST_CHANGE#', dataType: oracleNumber(20) },
    { name: 'NEXT_CHANGE#', dataType: oracleNumber(20) },
    { name: 'NEXT_TIME', dataType: oracleDate() },
    { name: 'ARCHIVED', dataType: oracleVarchar2(3) },
    { name: 'DELETED', dataType: oracleVarchar2(3) },
    { name: 'STATUS', dataType: oracleVarchar2(1) },
    { name: 'BLOCKS', dataType: oracleNumber(20) },
    { name: 'BLOCK_SIZE', dataType: oracleNumber(10) },
  ];
}
