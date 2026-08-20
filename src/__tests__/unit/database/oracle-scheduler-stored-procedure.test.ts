/**
 * DBMS_SCHEDULER STORED_PROCEDURE jobs invoke a real stored unit.
 *
 * Before: SchedulerManager.runJob routed every non-EXECUTABLE job through
 * `executeSql(job_action)` verbatim. PLSQL_BLOCK jobs (whose action is an
 * executable statement / anonymous block) worked, but a STORED_PROCEDURE
 * job carries only a *bare procedure name* in job_action — Oracle invokes
 * it as a call. Passing the bare name to executeSql is not valid SQL, so
 * STORED_PROCEDURE jobs always FAILED. The job_type was also silently
 * miscast to the literal 'PLSQL_BLOCK' in DBMS_SCHEDULER.CREATE_JOB.
 *
 * Now: CREATE_JOB preserves the real job_type, and a STORED_PROCEDURE job
 * is wrapped as `BEGIN <action>; END;` and run in the job owner's schema,
 * so an unqualified procedure name resolves against the owner — exactly as
 * a real scheduler slave would.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function boot(name: string): LinuxServer {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell.dispose();
  return srv;
}

function sql(srv: LinuxServer, lines: string[]): string {
  const s = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
  let out = '';
  for (const line of lines) out += s.processLine(line).output.join('\n') + '\n';
  s.dispose();
  return out;
}

describe('DBMS_SCHEDULER STORED_PROCEDURE jobs', () => {
  it('invokes the named procedure and persists its side effects', () => {
    const srv = boot('sched-sp-1');
    sql(srv, [
      'CREATE TABLE sp_audit (note VARCHAR2(40));',
      'CREATE OR REPLACE PROCEDURE log_run AS BEGIN '
        + "INSERT INTO sp_audit VALUES ('job-fired'); END;",
      "EXEC DBMS_SCHEDULER.CREATE_JOB('SP_JOB', 'STORED_PROCEDURE', 'LOG_RUN');",
      "EXEC DBMS_SCHEDULER.RUN_JOB('SP_JOB');",
    ]);

    const run = sql(srv, [
      "SELECT STATUS FROM DBA_SCHEDULER_JOB_RUN_DETAILS WHERE JOB_NAME='SP_JOB';",
    ]);
    expect(run).toMatch(/SUCCEEDED/);
    expect(run).not.toMatch(/FAILED/);

    const rows = sql(srv, ['SELECT note FROM sp_audit;']);
    expect(rows).toMatch(/job-fired/);
  });

  it('records the real job_type in DBA_SCHEDULER_JOBS (not miscast to PLSQL_BLOCK)', () => {
    const srv = boot('sched-sp-2');
    sql(srv, [
      'CREATE OR REPLACE PROCEDURE noop_proc AS BEGIN NULL; END;',
      "EXEC DBMS_SCHEDULER.CREATE_JOB('TYPED_JOB', 'STORED_PROCEDURE', 'NOOP_PROC');",
    ]);
    const out = sql(srv, [
      "SELECT JOB_TYPE FROM DBA_SCHEDULER_JOBS WHERE JOB_NAME='TYPED_JOB';",
    ]);
    expect(out).toMatch(/STORED_PROCEDURE/);
  });

  it('a missing procedure makes the run FAIL with a PL/SQL error', () => {
    const srv = boot('sched-sp-3');
    sql(srv, [
      "EXEC DBMS_SCHEDULER.CREATE_JOB('GHOST_JOB', 'STORED_PROCEDURE', 'NO_SUCH_PROC');",
      "EXEC DBMS_SCHEDULER.RUN_JOB('GHOST_JOB');",
    ]);
    const out = sql(srv, [
      "SELECT STATUS FROM DBA_SCHEDULER_JOB_RUN_DETAILS WHERE JOB_NAME='GHOST_JOB';",
    ]);
    expect(out).toMatch(/FAILED/);
  });
});
