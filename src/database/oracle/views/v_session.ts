/**
 * V$SESSION — active sessions + Oracle background processes.
 *
 * Real sessions come from the SecurityEngine session tracker; the four
 * mandatory background processes (PMON/SMON/DBW0/LGWR) are always shown,
 * matching a real instance. Falls back to a synthetic user session only
 * when no session has been registered yet.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$SESSION',
  comment: 'Active sessions',
  query({ catalog, currentUser }) {
    const cols = [
      { name: 'SID', dataType: oracleNumber(10) },
      { name: 'SERIAL#', dataType: oracleNumber(10) },
      { name: 'USERNAME', dataType: oracleVarchar2(128) },
      { name: 'STATUS', dataType: oracleVarchar2(8) },
      { name: 'OSUSER', dataType: oracleVarchar2(128) },
      { name: 'MACHINE', dataType: oracleVarchar2(64) },
      { name: 'PROGRAM', dataType: oracleVarchar2(64) },
      { name: 'TYPE', dataType: oracleVarchar2(10) },
      { name: 'LOGON_TIME', dataType: oracleDate() },
      { name: 'SCHEMANAME', dataType: oracleVarchar2(128) },
      { name: 'COMMAND', dataType: oracleNumber(10) },
      { name: 'SQL_ID', dataType: oracleVarchar2(13) },
      { name: 'TERMINAL', dataType: oracleVarchar2(30) },
      { name: 'BLOCKING_SESSION', dataType: oracleNumber(10) },
      { name: 'SQL_CHILD_NUMBER', dataType: oracleNumber(10) },
      { name: 'SQL_EXEC_START', dataType: oracleDate() },
      { name: 'SQL_EXEC_ID', dataType: oracleNumber(20) },
      { name: 'EVENT', dataType: oracleVarchar2(64) },
      { name: 'WAIT_CLASS', dataType: oracleVarchar2(64) },
      { name: 'SECONDS_IN_WAIT', dataType: oracleNumber(10) },
      { name: 'STATE', dataType: oracleVarchar2(32) },
      { name: 'LAST_CALL_ET', dataType: oracleNumber(10) },
      { name: 'SQL_TRACE', dataType: oracleVarchar2(8) },
      { name: 'RESOURCE_CONSUMER_GROUP', dataType: oracleVarchar2(32) },
      { name: 'SERVICE_NAME', dataType: oracleVarchar2(64) },
      { name: 'MODULE', dataType: oracleVarchar2(64) },
      { name: 'ACTION', dataType: oracleVarchar2(64) },
      { name: 'CLIENT_INFO', dataType: oracleVarchar2(64) },
      { name: 'PADDR', dataType: oracleVarchar2(16) },
      { name: 'TADDR', dataType: oracleVarchar2(16) },
      { name: 'LOCKWAIT', dataType: oracleVarchar2(16) },
    ];

    const engine = catalog.getSecurityEngine();
    const activeSessions = engine?.sessions.getAllSessions() ?? [];
    const now = new Date().toISOString();

    const bgRow = (sid: number, prog: string): (string | number | null)[] => [
      sid, 1, 'SYS', 'ACTIVE', 'oracle', 'localhost', prog, 'BACKGROUND',
      now, 'SYS', 0, null,
      'UNKNOWN', null, null, null, null,
      'pmon timer', 'Idle', 0, 'WAITING', 0, 'DISABLED',
      'SYS_GROUP', 'orcl', null, null, null, null, null, null,
    ];
    const bgRows: (string | number | null)[][] = [
      bgRow(1, 'oracle@localhost (PMON)'),
      bgRow(2, 'oracle@localhost (SMON)'),
      bgRow(3, 'oracle@localhost (DBW0)'),
      bgRow(4, 'oracle@localhost (LGWR)'),
    ];

    if (activeSessions.length > 0) {
      const userRows = activeSessions.map(s => [
        s.sid, s.serial, s.username, s.status,
        s.osUser, s.machine, s.program, s.type,
        s.logonTime.toISOString(), s.schema,
        3,
        s.sqlId,
        s.terminal,
        s.blockingSession,
        s.sqlChildNumber,
        s.sqlExecStart ? s.sqlExecStart.toISOString() : null,
        s.sqlExecStart ? 1 : null,
        s.event,
        s.waitClass,
        s.secondsInWait,
        s.state,
        s.lastCallEt,
        'DISABLED',
        s.resourceConsumerGroup,
        s.service,
        s.module,
        s.action,
        s.clientInfo,
        null, null, null,
      ]);
      return queryResult(cols, [...bgRows, ...userRows]);
    }

    const upper = currentUser.toUpperCase();
    return queryResult(cols, [
      ...bgRows,
      [
        10, 100, upper, 'ACTIVE', 'oracle', 'localhost',
        'sqlplus@localhost', 'USER', now, upper, 3, null,
        'pts/0', null, null, null, null,
        'SQL*Net message from client', 'Idle', 0, 'WAITING', 0, 'DISABLED',
        'DEFAULT_CONSUMER_GROUP', 'orcl', null, null, null, null, null, null,
      ],
    ]);
  },
});
