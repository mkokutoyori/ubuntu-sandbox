import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';
import { LOCK_MODE_NAMES, type LockMode } from '../lock/LockManager';

registerView({
  name: 'DBA_DML_LOCKS',
  comment: 'DML locks',
  query({ instance }) {
    const tm = instance.lockManager.getHeldLocks().filter(l => l.type === 'TM');
    const blockerSessions = new Set(instance.lockManager.getBlockers().map(b => b.holderSession));
    return queryResult(
      [
        { name: 'SESSION_ID', dataType: oracleNumber(10) },
        { name: 'OWNER', dataType: oracleVarchar2(128) },
        { name: 'NAME', dataType: oracleVarchar2(128) },
        { name: 'MODE_HELD', dataType: oracleVarchar2(13) },
        { name: 'MODE_REQUESTED', dataType: oracleVarchar2(13) },
        { name: 'LAST_CONVERT', dataType: oracleNumber(10) },
        { name: 'BLOCKING_OTHERS', dataType: oracleVarchar2(40) },
      ],
      tm.map(l => [
        l.sid, l.schema, l.table,
        LOCK_MODE_NAMES[l.lmode as LockMode],
        LOCK_MODE_NAMES[l.request as LockMode],
        0,
        blockerSessions.has(l.sessionId) ? 'Blocking' : 'Not Blocking',
      ]),
    );
  },
});
