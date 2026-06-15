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

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);

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

describe('DBMS_SCHEDULER EXECUTABLE jobs run on the host', () => {
  it('runs a host command and captures its output as SUCCEEDED', () => {
    const srv = boot('sched-1');
    sql(srv, [
      "EXEC DBMS_SCHEDULER.CREATE_JOB('ECHO_JOB', 'EXECUTABLE', 'echo scheduler-ran');",
      "EXEC DBMS_SCHEDULER.RUN_JOB('ECHO_JOB');",
    ]);
    const out = sql(srv, [
      "SELECT STATUS, OUTPUT FROM DBA_SCHEDULER_JOB_RUN_DETAILS WHERE JOB_NAME='ECHO_JOB';",
    ]);
    expect(out).toMatch(/SUCCEEDED/);
    expect(out).toMatch(/scheduler-ran/);
  });

  it('a failing command yields STATUS FAILED with ORA-27369', () => {
    const srv = boot('sched-2');
    sql(srv, [
      "EXEC DBMS_SCHEDULER.CREATE_JOB('BAD_JOB', 'EXECUTABLE', 'no_such_command_xyz');",
      "EXEC DBMS_SCHEDULER.RUN_JOB('BAD_JOB');",
    ]);
    const out = sql(srv, [
      "SELECT STATUS, ERROR# FROM DBA_SCHEDULER_JOB_RUN_DETAILS WHERE JOB_NAME='BAD_JOB';",
    ]);
    expect(out).toMatch(/FAILED/);
    expect(out).toMatch(/27369/);
  });

  it('the job really executes on the host (file it writes is visible to cat)', () => {
    const srv = boot('sched-3');
    sql(srv, [
      "EXEC DBMS_SCHEDULER.CREATE_JOB('WRITE_JOB', 'EXECUTABLE', 'echo from-the-job > /tmp/sched.out');",
      "EXEC DBMS_SCHEDULER.RUN_JOB('WRITE_JOB');",
    ]);
    expect(sh(srv, 'cat /tmp/sched.out')).toContain('from-the-job');
  });

  it('a PLSQL_BLOCK job still runs as SQL, not on the host', () => {
    const srv = boot('sched-4');
    sql(srv, [
      "EXEC DBMS_SCHEDULER.CREATE_JOB('PL_JOB', 'PLSQL_BLOCK', 'BEGIN NULL; END;');",
      "EXEC DBMS_SCHEDULER.RUN_JOB('PL_JOB');",
    ]);
    const out = sql(srv, [
      "SELECT STATUS FROM DBA_SCHEDULER_JOB_RUN_DETAILS WHERE JOB_NAME='PL_JOB';",
    ]);
    expect(out).toMatch(/SUCCEEDED/);
  });
});
