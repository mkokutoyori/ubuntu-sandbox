import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$LOCK',
  comment: 'Active locks',
  query({ runtime, instance }) {
    const cols = [
      { name: 'ADDR', dataType: oracleVarchar2(16) },
      { name: 'SID', dataType: oracleNumber(10) },
      { name: 'TYPE', dataType: oracleVarchar2(2) },
      { name: 'ID1', dataType: oracleNumber(20) },
      { name: 'ID2', dataType: oracleNumber(20) },
      { name: 'LMODE', dataType: oracleNumber(10) },
      { name: 'REQUEST', dataType: oracleNumber(10) },
      { name: 'BLOCK', dataType: oracleNumber(10) },
    ];
    const lmLocks = instance.lockManager.getHeldLocks();
    if (lmLocks.length > 0) {
      const blockers = new Set(instance.lockManager.getBlockers().map(b => b.holderSession));
      return queryResult(cols, lmLocks.map((l, i) => [
        `0x${(0x4000 + i).toString(16).toUpperCase()}`,
        l.sid, l.type, l.id1, l.id2, l.lmode, l.request,
        blockers.has(l.sessionId) ? 1 : 0,
      ]));
    }
    return queryResult(cols, runtime.locks.map((l, i) => [
      `0x${(0x4000 + i).toString(16).toUpperCase()}`,
      l.sid, l.type, l.id1, l.id2, l.lmode, l.request, l.block,
    ]));
  },
});
