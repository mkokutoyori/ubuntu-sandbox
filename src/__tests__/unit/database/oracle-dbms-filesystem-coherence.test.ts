/**
 * Tests for Oracle DBMS ↔ Linux filesystem coherence.
 *
 * Validates that Oracle internal state (tablespaces, datafiles, redo logs,
 * control files, background processes) is properly synchronized to the
 * Linux virtual filesystem, and that `ps` shows Oracle processes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import {
  initOracleFilesystem,
  getOracleDatabase,
  resetAllOracleInstances,
  syncDatafilesToDevice,
  syncOracleProcessesToDevice,
  syncAlertLogToDevice,
} from '@/terminal/commands/database';
import { ORACLE_CONFIG } from '@/terminal/commands/OracleConfig';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { OracleStorage } from '@/database/oracle/OracleStorage';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

const BASE = ORACLE_CONFIG.BASE;
const SID  = ORACLE_CONFIG.SID;
const ORADATA = ORACLE_CONFIG.ORADATA;

let server: LinuxServer;
let db: OracleDatabase;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
  server = new LinuxServer('linux-server', 'OracleDB1');
  initOracleFilesystem(server);
  db = getOracleDatabase(server.getId());
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 1: Datafile sync — tablespace datafiles appear on VFS
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: Datafile sync to VFS', () => {

  it('T01 — default tablespace datafiles exist on VFS', async () => {
    syncDatafilesToDevice(server, db);
    const output = await server.executeCommand(`ls ${ORADATA}`);
    expect(output).toContain('system01.dbf');
    expect(output).toContain('sysaux01.dbf');
    expect(output).toContain('undotbs01.dbf');
    expect(output).toContain('users01.dbf');
    expect(output).toContain('temp01.dbf');
  });

  it('T02 — datafile content contains tablespace type label', async () => {
    syncDatafilesToDevice(server, db);
    const content = await server.executeCommand(`cat ${ORADATA}/system01.dbf`);
    expect(content).toContain('ORACLE DATAFILE');
    expect(content).toContain('SYSTEM');
  });

  it('T03 — temp datafile content is labeled as TEMPFILE', async () => {
    syncDatafilesToDevice(server, db);
    const content = await server.executeCommand(`cat ${ORADATA}/temp01.dbf`);
    expect(content).toContain('TEMPFILE');
    expect(content).toContain('TEMP');
  });

  it('T04 — redo log files are synced to VFS', async () => {
    syncDatafilesToDevice(server, db);
    const output = await server.executeCommand(`ls ${ORADATA}`);
    expect(output).toContain('redo01.log');
    expect(output).toContain('redo02.log');
    expect(output).toContain('redo03.log');
  });

  it('T05 — redo log content contains REDO LOG label', async () => {
    syncDatafilesToDevice(server, db);
    const content = await server.executeCommand(`cat ${ORADATA}/redo01.log`);
    expect(content).toContain('ORACLE REDO LOG');
    expect(content).toContain('Group 1');
  });

  it('T06 — control files are synced to VFS', async () => {
    syncDatafilesToDevice(server, db);
    const output = await server.executeCommand(`ls ${ORADATA}`);
    expect(output).toContain('control01.ctl');
    expect(output).toContain('control02.ctl');
  });

  it('T07 — control file content contains CONTROL FILE label', async () => {
    syncDatafilesToDevice(server, db);
    const content = await server.executeCommand(`cat ${ORADATA}/control01.ctl`);
    expect(content).toContain('ORACLE CONTROL FILE');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 2: Oracle processes visible in ps
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: Oracle background processes in ps', () => {

  it('T08 — ps aux shows Oracle background processes after sync', async () => {
    syncOracleProcessesToDevice(server, db);
    const output = await server.executeCommand('ps aux');
    expect(output).toContain('ora_pmon');
    expect(output).toContain('ora_smon');
  });

  it('T09 — Oracle processes run under oracle user', async () => {
    syncOracleProcessesToDevice(server, db);
    const output = await server.executeCommand('ps aux');
    const lines = output.split('\n').filter(l => l.includes('ora_'));
    for (const line of lines) {
      expect(line).toMatch(/^oracle\s/);
    }
  });

  it('T10 — Oracle process names include SID', async () => {
    syncOracleProcessesToDevice(server, db);
    const output = await server.executeCommand('ps aux');
    const sidLower = SID.toLowerCase();
    const oraLines = output.split('\n').filter(l => l.includes('ora_'));
    for (const line of oraLines) {
      expect(line).toContain(sidLower);
    }
  });

  it('T11 — listener process appears in ps when listener is running', async () => {
    db.instance.startListener();
    syncOracleProcessesToDevice(server, db);
    const output = await server.executeCommand('ps aux');
    expect(output).toContain('tnslsnr');
    expect(output).toContain('LISTENER');
  });

  it('T12 — listener does NOT appear in ps when listener is stopped', async () => {
    // Ensure listener is stopped
    if (db.instance.listenerStatus === 'running') {
      db.instance.stopListener();
    }
    syncOracleProcessesToDevice(server, db);
    const output = await server.executeCommand('ps aux');
    expect(output).not.toContain('tnslsnr');
  });

  it('T13 — ps without aux only shows current user processes', async () => {
    syncOracleProcessesToDevice(server, db);
    const output = await server.executeCommand('ps');
    // ps (without aux) should show header + current user's processes only
    expect(output).toContain('PID');
    expect(output).toContain('CMD');
    // The init process belongs to root, shown only if current user is root
    expect(output).toContain('-bash');
  });

  it('T14 — ps -ef also shows Oracle processes', async () => {
    syncOracleProcessesToDevice(server, db);
    const output = await server.executeCommand('ps -ef');
    expect(output).toContain('ora_pmon');
    expect(output).toContain('ora_smon');
  });

  it('T15 — background processes include DBWR, LGWR, CKPT, etc.', async () => {
    syncOracleProcessesToDevice(server, db);
    const output = await server.executeCommand('ps aux');
    // Standard Oracle background processes
    expect(output).toContain('ora_pmon');
    expect(output).toContain('ora_smon');
    // Check that at least some of the common ones are present
    const hasDbwr = output.includes('ora_dbw') || output.includes('ora_db_');
    const hasLgwr = output.includes('ora_lgwr');
    const hasCkpt = output.includes('ora_ckpt');
    // At least one of these should be present beyond PMON/SMON
    expect(hasDbwr || hasLgwr || hasCkpt).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 3: Alert log coherence
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: Alert log sync', () => {

  it('T16 — alert log is written to correct dynamic path', async () => {
    const sidLower = SID.toLowerCase();
    const alertPath = `${BASE}/diag/rdbms/${sidLower}/${SID}/trace/alert_${SID}.log`;
    syncAlertLogToDevice(server, ['Starting ORACLE instance', 'Database mounted']);
    const content = await server.executeCommand(`cat ${alertPath}`);
    expect(content).toContain('Starting ORACLE instance');
    expect(content).toContain('Database mounted');
  });

  it('T17 — alert log path uses dynamic SID, not hardcoded', async () => {
    const sidLower = SID.toLowerCase();
    const alertPath = `${BASE}/diag/rdbms/${sidLower}/${SID}/trace/alert_${SID}.log`;
    syncAlertLogToDevice(server, ['test entry']);
    const content = await server.executeCommand(`cat ${alertPath}`);
    expect(content).toContain('test entry');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 4: OracleStorage uses centralized paths
// ═══════════════════════════════════════════════════════════════════

describe('Group 4: Centralized ORACLE_CONFIG paths', () => {

  it('T18 — OracleStorage datafile paths use ORACLE_CONFIG.ORADATA', () => {
    const storage = db.storage as OracleStorage;
    const tablespaces = storage.getAllTablespaces();
    for (const ts of tablespaces) {
      for (const df of ts.datafiles) {
        expect(df.path).toContain(ORADATA);
      }
    }
  });

  it('T19 — redo log paths use ORACLE_CONFIG.ORADATA', () => {
    const redoGroups = db.instance.getRedoLogGroups();
    for (const group of redoGroups) {
      for (const member of group.members) {
        expect(member).toContain(ORADATA);
      }
    }
  });

  it('T20 — control_files parameter uses ORACLE_CONFIG.ORADATA', () => {
    const ctlParam = db.instance.getParameter('control_files') ?? '';
    const ctlFiles = ctlParam.split(',').map(f => f.trim()).filter(f => f);
    expect(ctlFiles.length).toBeGreaterThan(0);
    for (const f of ctlFiles) {
      expect(f).toContain(ORADATA);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 5: V$DIAG_INFO coherence with ORACLE_CONFIG
// ═══════════════════════════════════════════════════════════════════

describe('Group 5: V$DIAG_INFO uses dynamic paths', () => {

  it('T21 — V$DIAG_INFO ADR_BASE uses ORACLE_CONFIG.BASE', () => {
    const conn = db.connectAsSysdba();
    const result = db.executeSql(conn.executor, "SELECT VALUE FROM V$DIAG_INFO WHERE NAME = 'ADR Base'");
    expect(result.rows.length).toBe(1);
    expect(result.rows[0][0]).toContain(BASE);
  });

  it('T22 — V$DIAG_INFO Diag Trace contains SID in path', () => {
    const conn = db.connectAsSysdba();
    const result = db.executeSql(conn.executor, "SELECT VALUE FROM V$DIAG_INFO WHERE NAME = 'Diag Trace'");
    expect(result.rows.length).toBe(1);
    const traceDir = String(result.rows[0][0]);
    expect(traceDir).toContain(SID.toLowerCase());
    expect(traceDir).toContain(SID);
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 6: ps command basic behavior
// ═══════════════════════════════════════════════════════════════════

describe('Group 6: ps command basics', () => {

  it('T23 — ps aux shows header with USER PID columns', async () => {
    const output = await server.executeCommand('ps aux');
    expect(output).toContain('USER');
    expect(output).toContain('PID');
    expect(output).toContain('COMMAND');
  });

  it('T24 — ps (no args) shows simpler header', async () => {
    const output = await server.executeCommand('ps');
    expect(output).toContain('PID');
    expect(output).toContain('TTY');
    expect(output).toContain('CMD');
  });

  it('T25 — ps always shows /sbin/init (PID 1)', async () => {
    const output = await server.executeCommand('ps aux');
    expect(output).toContain('/sbin/init');
  });

  it('T26 — ps always shows current shell (-bash)', async () => {
    const output = await server.executeCommand('ps aux');
    expect(output).toContain('-bash');
  });
});
