import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances, getOracleDatabase } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { CaptureProcess, ApplyProcess, GoldenGateExtract, GoldenGateReplicat } from '@/database/oracle/replication/Replication';

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

describe('Replication (Streams / GoldenGate)', () => {
  it('DBA_CAPTURE / DBA_APPLY reflect registered processes', () => {
    const { sh, deviceId } = newSession('rep-1');
    const db = getOracleDatabase(deviceId);
    db.instance.replication.addCapture(new CaptureProcess({ captureName: 'CAP1', startScn: 1000, state: 'CAPTURING CHANGES' }));
    db.instance.replication.addApply(new ApplyProcess({ applyName: 'APP1' }));
    const cap = run(sh, "SELECT CAPTURE_NAME, STATUS FROM DBA_CAPTURE WHERE CAPTURE_NAME='CAP1';");
    expect(cap).toMatch(/CAP1/);
    expect(cap).toMatch(/CAPTURING CHANGES/);
    const app = run(sh, "SELECT APPLY_NAME, STATUS FROM DBA_APPLY WHERE APPLY_NAME='APP1';");
    expect(app).toMatch(/APP1/);
    expect(app).toMatch(/ENABLED/);
    sh.dispose();
  });

  it('DBA_GG_EXTRACT / DBA_GG_REPLICAT reflect GoldenGate processes', () => {
    const { sh, deviceId } = newSession('rep-2');
    const db = getOracleDatabase(deviceId);
    db.instance.replication.addExtract(new GoldenGateExtract({ extractName: 'EXT1', sourceDb: 'ORCL', lagSeconds: 3 }));
    db.instance.replication.addReplicat(new GoldenGateReplicat({ replicatName: 'REP1', targetDb: 'TGT' }));
    const ext = run(sh, "SELECT EXTRACT_NAME, EXTRACT_TYPE, STATUS, LAG_SECONDS FROM DBA_GG_EXTRACT WHERE EXTRACT_NAME='EXT1';");
    expect(ext).toMatch(/EXT1/);
    expect(ext).toMatch(/INTEGRATED/);
    expect(ext).toMatch(/RUNNING/);
    const rep = run(sh, "SELECT REPLICAT_NAME, TARGET_DB FROM DBA_GG_REPLICAT WHERE REPLICAT_NAME='REP1';");
    expect(rep).toMatch(/REP1/);
    expect(rep).toMatch(/TGT/);
    sh.dispose();
  });
});

describe('Flashback Data Archive', () => {
  it('CREATE FLASHBACK ARCHIVE registers in DBA_FLASHBACK_ARCHIVE', () => {
    const { sh } = newSession('fba-1');
    sh.processLine('CREATE FLASHBACK ARCHIVE fla1 TABLESPACE USERS QUOTA 100 M RETENTION 365 DAY;');
    const out = run(sh, "SELECT FLASHBACK_ARCHIVE_NAME, RETENTION_IN_DAYS FROM DBA_FLASHBACK_ARCHIVE WHERE FLASHBACK_ARCHIVE_NAME='FLA1';");
    expect(out).toMatch(/FLA1/);
    expect(out).toMatch(/365/);
    sh.dispose();
  });

  it('ALTER TABLE ... FLASHBACK ARCHIVE enrolls the table', () => {
    const { sh } = newSession('fba-2');
    sh.processLine('CREATE FLASHBACK ARCHIVE fla2 TABLESPACE USERS RETENTION 30 DAY;');
    sh.processLine('CREATE TABLE FBA_T (id NUMBER);');
    sh.processLine('ALTER TABLE FBA_T FLASHBACK ARCHIVE fla2;');
    const out = run(sh, "SELECT TABLE_NAME, FLASHBACK_ARCHIVE_NAME, STATUS FROM DBA_FLASHBACK_ARCHIVE_TABLES WHERE TABLE_NAME='FBA_T';");
    expect(out).toMatch(/FBA_T/);
    expect(out).toMatch(/FLA2/);
    expect(out).toMatch(/ENABLED/);
    sh.dispose();
  });

  it('DBA_FLASHBACK_ARCHIVE_TS lists backing tablespaces', () => {
    const { sh } = newSession('fba-3');
    sh.processLine('CREATE FLASHBACK ARCHIVE fla3 TABLESPACE USERS QUOTA 50 M RETENTION 90 DAY;');
    const out = run(sh, "SELECT FLASHBACK_ARCHIVE_NAME, TABLESPACE_NAME, QUOTA_IN_MB FROM DBA_FLASHBACK_ARCHIVE_TS WHERE FLASHBACK_ARCHIVE_NAME='FLA3';");
    expect(out).toMatch(/FLA3/);
    expect(out).toMatch(/USERS/);
    expect(out).toMatch(/50/);
    sh.dispose();
  });
});

describe('Result Cache', () => {
  it('V$RESULT_CACHE_OBJECTS reflects cached results', () => {
    const { sh, deviceId } = newSession('rc-1');
    const db = getOracleDatabase(deviceId);
    const e = db.instance.resultCache.add('SELECT count(*) FROM HR.EMPLOYEES', { rowCount: 1, rowSize: 8, columnCount: 1, creator: 'HR' });
    db.instance.resultCache.addDependency('HR', 'EMPLOYEES', 'TABLE', e.id);
    const out = run(sh, 'SELECT TYPE, STATUS, NAME, DEPEND_COUNT FROM V$RESULT_CACHE_OBJECTS;');
    expect(out).toMatch(/Result/);
    expect(out).toMatch(/PUBLISHED/);
    expect(out).toMatch(/EMPLOYEES/);
    const dep = run(sh, "SELECT OBJECT_OWNER, OBJECT_NAME FROM V$RESULT_CACHE_DEPENDENCY WHERE OBJECT_NAME='EMPLOYEES';");
    expect(dep).toMatch(/HR\s+EMPLOYEES/);
    sh.dispose();
  });

  it('invalidating by object marks cached results INVALID', () => {
    const { sh, deviceId } = newSession('rc-2');
    const db = getOracleDatabase(deviceId);
    const e = db.instance.resultCache.add('SELECT * FROM HR.JOBS', { rowCount: 19, rowSize: 30 });
    db.instance.resultCache.addDependency('HR', 'JOBS', 'TABLE', e.id);
    const n = db.instance.resultCache.invalidateByObject('HR', 'JOBS');
    expect(n).toBe(1);
    const out = run(sh, "SELECT STATUS, INVALIDATIONS FROM V$RESULT_CACHE_OBJECTS WHERE NAME='SELECT * FROM HR.JOBS';");
    expect(out).toMatch(/INVALID/);
    sh.dispose();
  });
});

describe('In-Memory column store', () => {
  it('ALTER TABLE ... INMEMORY populates V$IM_SEGMENTS', () => {
    const { sh } = newSession('im-1');
    sh.processLine('CREATE TABLE IM_T (id NUMBER, name VARCHAR2(60));');
    sh.processLine('ALTER TABLE IM_T INMEMORY;');
    const out = run(sh, "SELECT SEGMENT_NAME, INMEMORY_PRIORITY, INMEMORY_COMPRESSION, POPULATE_STATUS FROM V$IM_SEGMENTS WHERE SEGMENT_NAME='IM_T';");
    expect(out).toMatch(/IM_T/);
    expect(out).toMatch(/MEDIUM/);
    expect(out).toMatch(/MEMCOMPRESS FOR QUERY LOW/);
    expect(out).toMatch(/COMPLETED/);
    sh.dispose();
  });

  it('ALTER TABLE ... NO INMEMORY removes the segment', () => {
    const { sh } = newSession('im-2');
    sh.processLine('CREATE TABLE IM_T2 (id NUMBER);');
    sh.processLine('ALTER TABLE IM_T2 INMEMORY;');
    sh.processLine('ALTER TABLE IM_T2 NO INMEMORY;');
    const out = run(sh, "SELECT SEGMENT_NAME FROM V$IM_SEGMENTS WHERE SEGMENT_NAME='IM_T2';");
    expect(out).not.toMatch(/IM_T2/);
    sh.dispose();
  });
});
