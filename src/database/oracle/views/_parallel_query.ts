/**
 * Parallel-execution dictionary views. The simulator does not run
 * actual PX slaves, so every view is empty (truthful) — they exist
 * so the canonical DBA queries parse and return no rows rather than
 * ORA-00942.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

const num = (name: string) => ({ name, dataType: oracleNumber(20) });
const str = (name: string, len: number) => ({ name, dataType: oracleVarchar2(len) });

registerView({
  name: 'V$PX_SESSION',
  comment: 'Parallel execution sessions',
  query() {
    return queryResult(
      [num('SADDR'), num('SID'), num('SERIAL#'), num('QCSID'), num('QCSERIAL#'),
       num('QCINST_ID'), num('SERVER_GROUP'), num('SERVER_SET'),
       num('SERVER#'), num('DEGREE'), num('REQ_DEGREE')],
      [],
    );
  },
});

registerView({
  name: 'V$PX_SESSTAT',
  comment: 'Parallel execution session statistics',
  query() {
    return queryResult(
      [num('SID'), num('SERIAL#'), num('QCSID'), num('QCSERIAL#'),
       num('STATISTIC#'), str('NAME', 64), num('VALUE')],
      [],
    );
  },
});

registerView({
  name: 'V$PX_PROCESS',
  comment: 'Parallel execution slave processes',
  query() {
    return queryResult(
      [str('SERVER_NAME', 4), str('STATUS', 20), num('PID'),
       num('SPID'), num('SID'), num('SERIAL#')],
      [],
    );
  },
});

registerView({
  name: 'V$PQ_SLAVE',
  comment: 'Parallel query slave processes (legacy)',
  query() {
    return queryResult(
      [str('SLAVE_NAME', 4), str('STATUS', 20),
       num('SESSIONS'), num('IDLE_TIME_CURRENT'),
       num('BUSY_TIME_CURRENT'), num('CPU_SECS_CURRENT'),
       num('MSGS_SENT_CURRENT'), num('MSGS_RCVD_CURRENT')],
      [],
    );
  },
});

registerView({
  name: 'V$PQ_SESSTAT',
  comment: 'Parallel query session statistics',
  query() {
    return queryResult(
      [str('STATISTIC', 30), num('LAST_QUERY'), num('SESSION_TOTAL')],
      [],
    );
  },
});

registerView({
  name: 'V$PQ_SYSSTAT',
  comment: 'Parallel query system statistics',
  query() {
    return queryResult(
      [str('STATISTIC', 30), num('VALUE')],
      [],
    );
  },
});

registerView({
  name: 'V$PQ_TQSTAT',
  comment: 'Parallel query table-queue statistics',
  query() {
    return queryResult(
      [num('DFO_NUMBER'), num('TQ_ID'), str('SERVER_TYPE', 10),
       num('NUM_ROWS'), num('BYTES'), num('OPEN_TIME'),
       num('AVG_LATENCY'), num('WAITS'), num('TIMEOUTS'),
       num('PROCESS'), num('INSTANCE')],
      [],
    );
  },
});
