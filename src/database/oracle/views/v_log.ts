/**
 * V$LOG — online redo log groups, from the live instance. Exposes the
 * canonical 19c column set (THREAD#, ARCHIVED, FIRST_CHANGE#, …) so DBA
 * scripts that filter on those columns work.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$LOG',
  comment: 'Online redo log groups',
  query({ instance }) {
    return queryResult(
      [
        { name: 'GROUP#', dataType: oracleNumber(10) },
        { name: 'THREAD#', dataType: oracleNumber(10) },
        { name: 'SEQUENCE#', dataType: oracleNumber(10) },
        { name: 'BYTES', dataType: oracleNumber(20) },
        { name: 'BLOCKSIZE', dataType: oracleNumber(10) },
        { name: 'MEMBERS', dataType: oracleNumber(10) },
        { name: 'ARCHIVED', dataType: oracleVarchar2(3) },
        { name: 'STATUS', dataType: oracleVarchar2(16) },
        { name: 'FIRST_CHANGE#', dataType: oracleNumber(20) },
        { name: 'FIRST_TIME', dataType: oracleDate() },
        { name: 'NEXT_CHANGE#', dataType: oracleNumber(20) },
        { name: 'NEXT_TIME', dataType: oracleDate() },
      ],
      instance.getRedoLogGroups().map(g => [
        g.group, 1, g.sequence, g.sizeBytes, 512, g.members.length,
        instance.archiveLogMode && g.status !== 'CURRENT' ? 'YES' : 'NO',
        g.status,
        100 + g.sequence, new Date('2026-01-01T00:00:00Z'),
        100 + g.sequence + 1, new Date('2026-01-01T00:00:00Z'),
      ])
    );
  },
});
