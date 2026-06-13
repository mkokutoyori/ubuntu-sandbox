/**
 * V$PROCESS — background AND dedicated server processes, from the live
 * instance. Server rows follow the real shape: PNAME null, BACKGROUND
 * null, PROGRAM oracle@host — one per connected user session, joinable
 * with V$SESSION through PADDR = ADDR.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';
import { processAddr } from './_processAddr';

registerView({
  name: 'V$PROCESS',
  comment: 'Background and server processes',
  query({ instance }) {
    const bgRows = instance.getBackgroundProcesses().map(p => [
      processAddr(p.pid),
      p.pid, p.pid,
      p.name,
      'oracle',
      `oracle@${instance.config.sid} (${p.name})`,
      'localhost',
      'pts/0',
      'oracle',
      instance.state === 'OPEN' ? 'ACTIVE' : 'INACTIVE',
      '1',
      p.description,
    ]);
    const serverRows = instance.getServerProcesses().map(p => [
      processAddr(p.pid),
      p.pid, p.pid,
      null, // PNAME is null for dedicated servers
      'oracle',
      `oracle@${instance.config.sid}`,
      'localhost',
      p.local ? 'pts/0' : null,
      p.osUser,
      'ACTIVE',
      null, // BACKGROUND is null for dedicated servers
      null,
    ]);
    return queryResult(
      [
        { name: 'ADDR', dataType: oracleVarchar2(16) },
        { name: 'PID', dataType: oracleNumber(10) },
        { name: 'SPID', dataType: oracleNumber(10) },
        { name: 'PNAME', dataType: oracleVarchar2(5) },
        { name: 'USERNAME', dataType: oracleVarchar2(30) },
        { name: 'PROGRAM', dataType: oracleVarchar2(64) },
        { name: 'MACHINE', dataType: oracleVarchar2(64) },
        { name: 'TERMINAL', dataType: oracleVarchar2(30) },
        { name: 'OSUSER', dataType: oracleVarchar2(30) },
        { name: 'STATUS', dataType: oracleVarchar2(10) },
        { name: 'BACKGROUND', dataType: oracleVarchar2(1) },
        { name: 'DESCRIPTION', dataType: oracleVarchar2(64) },
      ],
      [...bgRows, ...serverRows],
    );
  },
});
