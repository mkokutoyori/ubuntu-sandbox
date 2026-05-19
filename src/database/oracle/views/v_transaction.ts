/**
 * V$TRANSACTION — active transactions, derived from the live runtime
 * transaction map maintained by OracleRuntimeStateActor. One row per
 * still-active txId; COMMITTED / ROLLED_BACK entries are pruned by
 * the actor.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$TRANSACTION',
  comment: 'Active transactions',
  query({ runtime }) {
    const rows: (string | number)[][] = [];
    for (const t of runtime.transactions.values()) {
      if (t.status !== 'ACTIVE') continue;
      // Synthesise plausible XID parts from txId so DBA queries that
      // filter on XIDUSN / XIDSLOT / XIDSQN still find rows.
      const xidusn = 1 + (t.txId % 30);
      const xidslot = Math.floor(t.txId / 30) % 1024;
      const xidsqn = t.txId;
      rows.push([
        `0x${t.txId.toString(16).padStart(12, '0').toUpperCase()}`,
        xidusn, xidslot, xidsqn,
        t.status,
        new Date(t.startedAt).toISOString().slice(0, 19).replace('T', ' '),
        t.usedUblk, t.usedUrec,
      ]);
    }
    return queryResult(
      [
        { name: 'ADDR', dataType: oracleVarchar2(16) },
        { name: 'XIDUSN', dataType: oracleNumber(10) },
        { name: 'XIDSLOT', dataType: oracleNumber(10) },
        { name: 'XIDSQN', dataType: oracleNumber(10) },
        { name: 'STATUS', dataType: oracleVarchar2(16) },
        { name: 'START_TIME', dataType: oracleVarchar2(20) },
        { name: 'USED_UBLK', dataType: oracleNumber(10) },
        { name: 'USED_UREC', dataType: oracleNumber(10) },
      ],
      rows,
    );
  },
});
