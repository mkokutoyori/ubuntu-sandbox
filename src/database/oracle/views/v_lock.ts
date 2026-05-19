/**
 * V$LOCK — active locks. Rows derive from the runtime lock table
 * maintained by OracleRuntimeStateActor on every `oracle.lock.event`.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$LOCK',
  comment: 'Active locks',
  query({ runtime }) {
    return queryResult(
      [
        { name: 'ADDR', dataType: oracleVarchar2(16) },
        { name: 'SID', dataType: oracleNumber(10) },
        { name: 'TYPE', dataType: oracleVarchar2(2) },
        { name: 'ID1', dataType: oracleNumber(20) },
        { name: 'ID2', dataType: oracleNumber(20) },
        { name: 'LMODE', dataType: oracleNumber(10) },
        { name: 'REQUEST', dataType: oracleNumber(10) },
        { name: 'BLOCK', dataType: oracleNumber(10) },
      ],
      runtime.locks.map((l, i) => [
        `0x${(0x4000 + i).toString(16).toUpperCase()}`,
        l.sid, l.type, l.id1, l.id2, l.lmode, l.request, l.block,
      ]),
    );
  },
});
