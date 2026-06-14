/**
 * DBMS_SCHEDULER jobs auto-run on their schedule (CJQ0 sweeper).
 *
 * Before: `reattachRefreshActor` (invoked by the boot wiring's
 * setEventBus()/setDeviceId(), both called AFTER the constructor's
 * attachScheduler()) tore the CJQ0 sweeper down and — unlike every other
 * actor — never recreated it. On a real device the sweeper ended up null,
 * so a job created with DBMS_SCHEDULER.CREATE_JOB never ran unless the DBA
 * manually called RUN_JOB. SHUTDOWN/STARTUP also lost the sweeper for good.
 *
 * Now CJQ0 lives across reattach and resumes at every open. These tests
 * drive the coordinator's tick through a VirtualTimeScheduler so the
 * auto-execution is deterministic (no real wall-clock waiting).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

let vts: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
  // Install the virtual clock BEFORE the first sqlplus boots the
  // database, so the CJQ0 sweeper picks it up as its event loop.
  vts = new VirtualTimeScheduler();
  __setDefaultScheduler(vts);
});

afterEach(() => {
  __setDefaultScheduler(null);
});

function boot(name: string): SqlPlusSubShell {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  return SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
}

const run = (sh: SqlPlusSubShell, sql: string) => sh.processLine(sql).output.join('\n');

describe('CJQ0 sweeper auto-executes due jobs', () => {
  it('a one-time job runs on the next sweep without RUN_JOB', () => {
    const sh = boot('autorun-1');
    run(sh, 'CREATE TABLE auto_t (id NUMBER);');
    // enabled, no start_date → next_run_date defaults to creation time,
    // so the job is immediately due.
    run(sh,
      "BEGIN DBMS_SCHEDULER.CREATE_JOB('AUTO_JOB', 'PLSQL_BLOCK', "
      + "'INSERT INTO auto_t VALUES (42)', '', '', '', 'TRUE'); END;");

    // Nothing has swept yet.
    expect(run(sh, 'SELECT COUNT(*) FROM auto_t;')).toMatch(/\b0\b/);

    // Advance past one 1000 ms coordinator tick.
    vts.advance(1100);

    expect(run(sh, 'SELECT id FROM auto_t;')).toMatch(/42/);
    const runs = run(sh,
      "SELECT STATUS FROM DBA_SCHEDULER_JOB_RUN_DETAILS WHERE JOB_NAME='AUTO_JOB';");
    expect(runs).toMatch(/SUCCEEDED/);
    sh.dispose();
  });

  it('a disabled job is NOT swept', () => {
    const sh = boot('autorun-2');
    run(sh, 'CREATE TABLE auto_d (id NUMBER);');
    run(sh,
      "BEGIN DBMS_SCHEDULER.CREATE_JOB('DIS_JOB', 'PLSQL_BLOCK', "
      + "'INSERT INTO auto_d VALUES (1)', '', '', '', 'FALSE'); END;");
    vts.advance(2000);
    expect(run(sh, 'SELECT COUNT(*) FROM auto_d;')).toMatch(/\b0\b/);
    sh.dispose();
  });

  it('the sweeper survives a SHUTDOWN/STARTUP cycle', () => {
    const sh = boot('autorun-3');
    run(sh, 'CREATE TABLE auto_r (id NUMBER);');
    run(sh, 'COMMIT;');
    sh.processLine('SHUTDOWN IMMEDIATE');
    sh.processLine('STARTUP');
    run(sh,
      "BEGIN DBMS_SCHEDULER.CREATE_JOB('RESTART_JOB', 'PLSQL_BLOCK', "
      + "'INSERT INTO auto_r VALUES (7)', '', '', '', 'TRUE'); END;");
    vts.advance(1100);
    expect(run(sh, 'SELECT id FROM auto_r;')).toMatch(/7/);
    sh.dispose();
  });
});
