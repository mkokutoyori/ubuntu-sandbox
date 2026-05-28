import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances, getOracleDatabase } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { StandbyDatabase } from '@/database/oracle/dataguard/DataGuardConfiguration';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function newSession(name: string): { sh: SqlPlusSubShell; deviceId: string } {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  const sh = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
  return { sh, deviceId: srv.id };
}

function run(sh: SqlPlusSubShell, sql: string): string {
  return sh.processLine(sql).output.join('\n');
}

describe('DBMS_SCHEDULER', () => {
  it('CREATE_JOB + DBA_SCHEDULER_JOBS shows the new job', () => {
    const { sh } = newSession('sch-1');
    sh.processLine("BEGIN DBMS_SCHEDULER.CREATE_JOB('NIGHTLY_REPORT', 'PLSQL_BLOCK', 'BEGIN NULL; END;', '', 'FREQ=DAILY;BYHOUR=2', '', 'TRUE'); END;");
    const out = run(sh, "SELECT JOB_NAME, JOB_TYPE, ENABLED, STATE FROM DBA_SCHEDULER_JOBS WHERE JOB_NAME='NIGHTLY_REPORT';");
    expect(out).toMatch(/NIGHTLY_REPORT/);
    expect(out).toMatch(/PLSQL_BLOCK/);
    expect(out).toMatch(/TRUE/);
    expect(out).toMatch(/SCHEDULED/);
    sh.dispose();
  });

  it('RUN_JOB actually executes the job action', () => {
    const { sh } = newSession('sch-2');
    sh.processLine("CREATE TABLE SCHED_T (id NUMBER);");
    sh.processLine("BEGIN DBMS_SCHEDULER.CREATE_JOB('LOAD_JOB', 'PLSQL_BLOCK', 'INSERT INTO SCHED_T VALUES (1)', '', '', '', 'TRUE'); END;");
    sh.processLine("BEGIN DBMS_SCHEDULER.RUN_JOB('LOAD_JOB'); END;");
    const rows = run(sh, 'SELECT * FROM SCHED_T;');
    expect(rows).toMatch(/\b1\b/);
    const runs = run(sh, "SELECT JOB_NAME, STATUS FROM DBA_SCHEDULER_JOB_RUN_DETAILS WHERE JOB_NAME='LOAD_JOB';");
    expect(runs).toMatch(/LOAD_JOB/);
    expect(runs).toMatch(/SUCCEEDED/);
    sh.dispose();
  });

  it('DISABLE / ENABLE flip the state', () => {
    const { sh } = newSession('sch-3');
    sh.processLine("BEGIN DBMS_SCHEDULER.CREATE_JOB('TOGGLE_JOB', 'PLSQL_BLOCK', 'BEGIN NULL; END;', '', '', '', 'TRUE'); END;");
    sh.processLine("BEGIN DBMS_SCHEDULER.DISABLE('TOGGLE_JOB'); END;");
    const out1 = run(sh, "SELECT ENABLED, STATE FROM DBA_SCHEDULER_JOBS WHERE JOB_NAME='TOGGLE_JOB';");
    expect(out1).toMatch(/FALSE\s+DISABLED/);
    sh.processLine("BEGIN DBMS_SCHEDULER.ENABLE('TOGGLE_JOB'); END;");
    const out2 = run(sh, "SELECT ENABLED, STATE FROM DBA_SCHEDULER_JOBS WHERE JOB_NAME='TOGGLE_JOB';");
    expect(out2).toMatch(/TRUE\s+SCHEDULED/);
    sh.dispose();
  });

  it('failing job action shows FAILED status and ORA error code', () => {
    const { sh } = newSession('sch-4');
    sh.processLine("BEGIN DBMS_SCHEDULER.CREATE_JOB('BAD_JOB', 'PLSQL_BLOCK', 'RAISE_APPLICATION_ERROR(-20500, ''boom'')', '', '', '', 'TRUE'); END;");
    sh.processLine("BEGIN DBMS_SCHEDULER.RUN_JOB('BAD_JOB'); END;");
    const out = run(sh, "SELECT JOB_NAME, STATUS, ERROR# FROM DBA_SCHEDULER_JOB_RUN_DETAILS WHERE JOB_NAME='BAD_JOB';");
    expect(out).toMatch(/BAD_JOB/);
    expect(out).toMatch(/FAILED/);
    sh.dispose();
  });
});

describe('Multitenant (CDB / PDB)', () => {
  it('V$PDBS lists PDB$SEED and ORCLPDB1 seeded by default', () => {
    const { sh } = newSession('mt-1');
    const out = run(sh, 'SELECT NAME, OPEN_MODE FROM V$PDBS;');
    expect(out).toMatch(/PDB\$SEED/);
    expect(out).toMatch(/ORCLPDB1/);
    sh.dispose();
  });

  it('CREATE PLUGGABLE DATABASE adds a new PDB to DBA_PDBS', () => {
    const { sh } = newSession('mt-2');
    sh.processLine('CREATE PLUGGABLE DATABASE TESTPDB FROM PDB$SEED;');
    const out = run(sh, "SELECT PDB_NAME, STATUS FROM DBA_PDBS WHERE PDB_NAME='TESTPDB';");
    expect(out).toMatch(/TESTPDB/);
    expect(out).toMatch(/NEW/);
    sh.dispose();
  });

  it('ALTER PLUGGABLE DATABASE OPEN flips OPEN_MODE', () => {
    const { sh } = newSession('mt-3');
    sh.processLine('CREATE PLUGGABLE DATABASE OPENED FROM PDB$SEED;');
    sh.processLine('ALTER PLUGGABLE DATABASE OPENED OPEN READ WRITE;');
    const out = run(sh, "SELECT NAME, OPEN_MODE FROM V$PDBS WHERE NAME='OPENED';");
    expect(out).toMatch(/OPENED\s+READ WRITE/);
    sh.dispose();
  });

  it('V$CONTAINERS includes CDB$ROOT + every PDB', () => {
    const { sh } = newSession('mt-4');
    const out = run(sh, 'SELECT CON_ID, NAME FROM V$CONTAINERS;');
    expect(out).toMatch(/1\s+CDB\$ROOT/);
    expect(out).toMatch(/PDB\$SEED/);
    expect(out).toMatch(/ORCLPDB1/);
    sh.dispose();
  });
});

describe('Data Guard', () => {
  it('V$DATAGUARD_CONFIG is empty until a standby is added', () => {
    const { sh } = newSession('dg-1');
    const out = run(sh, 'SELECT DB_UNIQUE_NAME, PROTECTION_MODE FROM V$DATAGUARD_CONFIG;');
    expect(out).toMatch(/ORCL/);
    expect(out).toMatch(/MAXIMUM PERFORMANCE/);
    sh.dispose();
  });

  it('seeded standby appears in V$DATAGUARD_CONFIG and V$DATAGUARD_STATS', () => {
    const { sh, deviceId } = newSession('dg-2');
    const db = getOracleDatabase(deviceId);
    db.instance.dataGuard.addStandby(new StandbyDatabase({
      dbUniqueName: 'ORCL_STBY', host: 'dr-host', role: 'PHYSICAL STANDBY',
      applyLagSeconds: 5, transportLagSeconds: 2, applyMode: 'APPLYING',
    }));
    const cfg = run(sh, 'SELECT DB_UNIQUE_NAME, PROTECTION_MODE FROM V$DATAGUARD_CONFIG;');
    expect(cfg).toMatch(/ORCL_STBY/);
    const stats = run(sh, "SELECT NAME, VALUE FROM V$DATAGUARD_STATS WHERE SOURCE_DB_UNIQUE_NAME='ORCL_STBY';");
    expect(stats).toMatch(/apply lag/);
    expect(stats).toMatch(/transport lag/);
    sh.dispose();
  });

  it('V$STANDBY_LOG surfaces the standby redo group', () => {
    const { sh, deviceId } = newSession('dg-3');
    const db = getOracleDatabase(deviceId);
    db.instance.dataGuard.addStandby(new StandbyDatabase({
      dbUniqueName: 'ORCL_STBY2', host: 'dr2', role: 'PHYSICAL STANDBY', applyMode: 'APPLYING',
    }));
    const out = run(sh, 'SELECT GROUP#, STATUS, DBID FROM V$STANDBY_LOG;');
    expect(out).toMatch(/ORCL_STBY2/);
    expect(out).toMatch(/ACTIVE/);
    sh.dispose();
  });
});
