/**
 * V$SESSION — active sessions + Oracle background processes.
 *
 * Real sessions come from the SecurityEngine session tracker; the four
 * mandatory background processes (PMON/SMON/DBW0/LGWR) are always shown,
 * matching a real instance. Falls back to a synthetic user session only
 * when no session has been registered yet.
 *
 * Column shape follows Oracle 19c V$SESSION: every commonly-queried
 * column is present even when we can't yet supply a non-trivial value,
 * so monitoring scripts that SELECT explicit columns find them.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$SESSION',
  comment: 'Active sessions',
  query({ catalog, currentUser }) {
    const cols = [
      { name: 'SADDR', dataType: oracleVarchar2(16) },
      { name: 'SID', dataType: oracleNumber(10) },
      { name: 'SERIAL#', dataType: oracleNumber(10) },
      { name: 'AUDSID', dataType: oracleNumber(10) },
      { name: 'PADDR', dataType: oracleVarchar2(16) },
      { name: 'USER#', dataType: oracleNumber(10) },
      { name: 'USERNAME', dataType: oracleVarchar2(128) },
      { name: 'COMMAND', dataType: oracleNumber(10) },
      { name: 'OWNERID', dataType: oracleNumber(10) },
      { name: 'TADDR', dataType: oracleVarchar2(16) },
      { name: 'LOCKWAIT', dataType: oracleVarchar2(16) },
      { name: 'STATUS', dataType: oracleVarchar2(8) },
      { name: 'SERVER', dataType: oracleVarchar2(9) },
      { name: 'SCHEMA#', dataType: oracleNumber(10) },
      { name: 'SCHEMANAME', dataType: oracleVarchar2(128) },
      { name: 'OSUSER', dataType: oracleVarchar2(128) },
      { name: 'PROCESS', dataType: oracleVarchar2(24) },
      { name: 'MACHINE', dataType: oracleVarchar2(64) },
      { name: 'PORT', dataType: oracleNumber(10) },
      { name: 'TERMINAL', dataType: oracleVarchar2(30) },
      { name: 'PROGRAM', dataType: oracleVarchar2(64) },
      { name: 'TYPE', dataType: oracleVarchar2(10) },
      { name: 'SQL_ADDRESS', dataType: oracleVarchar2(16) },
      { name: 'SQL_HASH_VALUE', dataType: oracleNumber(20) },
      { name: 'SQL_ID', dataType: oracleVarchar2(13) },
      { name: 'SQL_CHILD_NUMBER', dataType: oracleNumber(10) },
      { name: 'SQL_EXEC_START', dataType: oracleDate() },
      { name: 'SQL_EXEC_ID', dataType: oracleNumber(20) },
      { name: 'PREV_SQL_ID', dataType: oracleVarchar2(13) },
      { name: 'MODULE', dataType: oracleVarchar2(64) },
      { name: 'ACTION', dataType: oracleVarchar2(64) },
      { name: 'CLIENT_INFO', dataType: oracleVarchar2(64) },
      { name: 'CLIENT_IDENTIFIER', dataType: oracleVarchar2(64) },
      { name: 'FIXED_TABLE_SEQUENCE', dataType: oracleNumber(10) },
      { name: 'ROW_WAIT_OBJ#', dataType: oracleNumber(10) },
      { name: 'ROW_WAIT_FILE#', dataType: oracleNumber(10) },
      { name: 'ROW_WAIT_BLOCK#', dataType: oracleNumber(10) },
      { name: 'ROW_WAIT_ROW#', dataType: oracleNumber(10) },
      { name: 'LOGON_TIME', dataType: oracleDate() },
      { name: 'LAST_CALL_ET', dataType: oracleNumber(10) },
      { name: 'PDML_ENABLED', dataType: oracleVarchar2(3) },
      { name: 'FAILOVER_TYPE', dataType: oracleVarchar2(13) },
      { name: 'FAILOVER_METHOD', dataType: oracleVarchar2(10) },
      { name: 'FAILED_OVER', dataType: oracleVarchar2(3) },
      { name: 'RESOURCE_CONSUMER_GROUP', dataType: oracleVarchar2(32) },
      { name: 'PDML_STATUS', dataType: oracleVarchar2(8) },
      { name: 'PDDL_STATUS', dataType: oracleVarchar2(8) },
      { name: 'PQ_STATUS', dataType: oracleVarchar2(8) },
      { name: 'EVENT#', dataType: oracleNumber(10) },
      { name: 'EVENT', dataType: oracleVarchar2(64) },
      { name: 'WAIT_CLASS#', dataType: oracleNumber(10) },
      { name: 'WAIT_CLASS', dataType: oracleVarchar2(64) },
      { name: 'WAIT_TIME', dataType: oracleNumber(10) },
      { name: 'SECONDS_IN_WAIT', dataType: oracleNumber(10) },
      { name: 'STATE', dataType: oracleVarchar2(32) },
      { name: 'BLOCKING_SESSION_STATUS', dataType: oracleVarchar2(11) },
      { name: 'BLOCKING_SESSION', dataType: oracleNumber(10) },
      { name: 'SQL_TRACE', dataType: oracleVarchar2(8) },
      { name: 'SERVICE_NAME', dataType: oracleVarchar2(64) },
      { name: 'CON_ID', dataType: oracleNumber(10) },
    ];

    const engine = catalog.getSecurityEngine();
    const activeSessions = engine?.sessions.getAllSessions() ?? [];
    const now = new Date().toISOString();
    const saddr = (sid: number) => `00000000${sid.toString(16).padStart(8, '0').toUpperCase()}`;
    const paddr = (sid: number) => `0000FFFF${(sid * 17).toString(16).padStart(8, '0').toUpperCase()}`;

    const bgRow = (sid: number, prog: string): (string | number | null)[] => [
      saddr(sid), sid, 1, 0, paddr(sid),
      0, 'SYS', 0, 2147483644, null, null, 'ACTIVE',
      'DEDICATED', 0, 'SYS', 'oracle', String(sid),
      'localhost', 0, 'pts/0', prog, 'BACKGROUND',
      null, 0, null, null, null, null, null,
      null, null, null, null, 0, 0, 0, 0, 0,
      now, 0, 'NO', 'NONE', 'NONE', 'NO',
      'SYS_GROUP', 'DISABLED', 'ENABLED', 'ENABLED',
      0, 'pmon timer', 6, 'Idle', 0, 0, 'WAITING',
      'NO HOLDER', null, 'DISABLED', 'orcl', 1,
    ];

    const bgRows: (string | number | null)[][] = [
      bgRow(1, 'oracle@localhost (PMON)'),
      bgRow(2, 'oracle@localhost (SMON)'),
      bgRow(3, 'oracle@localhost (DBW0)'),
      bgRow(4, 'oracle@localhost (LGWR)'),
    ];

    if (activeSessions.length > 0) {
      const userRows = activeSessions.map(s => [
        saddr(s.sid), s.sid, s.serial, s.sid, paddr(s.sid),
        s.sid, s.username, 3, 2147483644, null, null, s.status,
        'DEDICATED', s.sid, s.schema, s.osUser, String(s.sid),
        s.machine, 0, s.terminal, s.program, s.type,
        null, 0, s.sqlId, s.sqlChildNumber,
        s.sqlExecStart ? s.sqlExecStart.toISOString() : null,
        s.sqlExecStart ? 1 : null,
        null,
        s.module, s.action, s.clientInfo,
        // CLIENT_IDENTIFIER — DBMS_SESSION.SET_IDENTIFIER target. None set
        // unless the simulator wires it; mirror real Oracle's behaviour.
        null,
        0, 0, 0, 0, 0,
        s.logonTime.toISOString(), s.lastCallEt,
        'NO', 'NONE', 'NONE', 'NO',
        s.resourceConsumerGroup, 'DISABLED', 'ENABLED', 'ENABLED',
        0, s.event, 6, s.waitClass, 0, s.secondsInWait, s.state,
        s.blockingSession === null ? 'NO HOLDER' : 'VALID',
        s.blockingSession, 'DISABLED', s.service, 1,
      ]);
      return queryResult(cols, [...bgRows, ...userRows]);
    }

    const upper = currentUser.toUpperCase();
    return queryResult(cols, [
      ...bgRows,
      [
        saddr(10), 10, 100, 10, paddr(10),
        10, upper, 3, 2147483644, null, null, 'ACTIVE',
        'DEDICATED', 10, upper, 'oracle', '10',
        'localhost', 0, 'pts/0', 'sqlplus@localhost', 'USER',
        null, 0, null, null, null, null, null,
        null, null, null, null, 0, 0, 0, 0, 0,
        now, 0, 'NO', 'NONE', 'NONE', 'NO',
        'DEFAULT_CONSUMER_GROUP', 'DISABLED', 'ENABLED', 'ENABLED',
        0, 'SQL*Net message from client', 6, 'Idle', 0, 0, 'WAITING',
        'NO HOLDER', null, 'DISABLED', 'orcl', 1,
      ],
    ]);
  },
});
