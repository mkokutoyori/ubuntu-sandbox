/**
 * V$PROCESS — background/server processes, from the live instance.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$PROCESS',
  comment: 'Background and server processes',
  query({ instance }) {
    return queryResult(
      [
        { name: 'ADDR', dataType: oracleVarchar2(16) },
        { name: 'PID', dataType: oracleNumber(10) },
        { name: 'SPID', dataType: oracleNumber(10) },
        { name: 'PNAME', dataType: oracleVarchar2(5) },
        { name: 'USERNAME', dataType: oracleVarchar2(30) },
        { name: 'PROGRAM', dataType: oracleVarchar2(64) },
        { name: 'STATUS', dataType: oracleVarchar2(10) },
        { name: 'BACKGROUND', dataType: oracleVarchar2(1) },
        { name: 'DESCRIPTION', dataType: oracleVarchar2(64) },
      ],
      instance.getBackgroundProcesses().map((p, idx) => [
        addrOf(idx),
        p.pid, p.pid,
        p.name,
        'oracle',
        `oracle@${instance.config.sid} (${p.name})`,
        instance.state === 'OPEN' ? 'ACTIVE' : 'INACTIVE',
        '1',
        p.description,
      ])
    );
  },
});

function addrOf(idx: number): string {
  return `0x${(0x7f0000 + idx * 0x100).toString(16).toUpperCase()}`;
}
