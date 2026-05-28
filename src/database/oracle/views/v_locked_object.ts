import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$LOCKED_OBJECT',
  comment: 'Locked objects',
  query({ instance, catalog }) {
    const userBySid = new Map<number, string>();
    const engine = catalog.getSecurityEngine();
    for (const s of engine?.sessions.getAllSessions() ?? []) userBySid.set(s.sid, s.username);
    const tm = instance.lockManager.getHeldLocks().filter(l => l.type === 'TM' && l.lmode > 0);
    return queryResult(
      [
        { name: 'XIDUSN', dataType: oracleNumber(10) },
        { name: 'XIDSLOT', dataType: oracleNumber(10) },
        { name: 'XIDSQN', dataType: oracleNumber(10) },
        { name: 'OBJECT_ID', dataType: oracleNumber(10) },
        { name: 'SESSION_ID', dataType: oracleNumber(10) },
        { name: 'ORACLE_USERNAME', dataType: oracleVarchar2(128) },
        { name: 'OS_USER_NAME', dataType: oracleVarchar2(128) },
        { name: 'LOCKED_MODE', dataType: oracleNumber(10) },
      ],
      tm.map(l => [
        l.txId ?? 0, 0, 0, l.id1, l.sid,
        userBySid.get(l.sid) ?? 'SYS', 'oracle', l.lmode,
      ]),
    );
  },
});
