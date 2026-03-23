/**
 * Tests for BRD Section 4 — Oracle Configuration Files.
 *
 * Covers: filesystem tree, config files content, spfile/init.ora parameters,
 * V$PARAMETER / V$SPPARAMETER views, SHOW PARAMETER / SHOW SPPARAMETER,
 * ALTER SYSTEM SET with SCOPE, dynamic alert log, parameter metadata.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import { SQLPlusSession } from '../../../database/oracle/commands/SQLPlusSession';

let db: OracleDatabase;
let executor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'];
let session: SQLPlusSession;

function exec(sql: string) {
  return db.executeSql(executor, sql);
}

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  const conn = db.connectAsSysdba();
  executor = conn.executor;
  session = new SQLPlusSession(db);
  session.login('SYS', 'oracle', true);
});

// ── 4.1 init.ora / spfile Parameters ─────────────────────────────

describe('Init Parameters (Section 4.1)', () => {

  test('db_name parameter is set to ORCL', () => {
    const val = db.instance.getParameter('db_name');
    expect(val).toBe('ORCL');
  });

  test('db_block_size parameter is 8192', () => {
    const val = db.instance.getParameter('db_block_size');
    expect(val).toBe('8192');
  });

  test('sga_target parameter is set', () => {
    const val = db.instance.getParameter('sga_target');
    expect(val).toBeTruthy();
  });

  test('sga_max_size parameter is set', () => {
    const val = db.instance.getParameter('sga_max_size');
    expect(val).toBe('1G');
  });

  test('pga_aggregate_target parameter is set', () => {
    const val = db.instance.getParameter('pga_aggregate_target');
    expect(val).toBeTruthy();
  });

  test('processes parameter is 300', () => {
    expect(db.instance.getParameter('processes')).toBe('300');
  });

  test('sessions parameter is 472', () => {
    expect(db.instance.getParameter('sessions')).toBe('472');
  });

  test('open_cursors parameter is 300', () => {
    expect(db.instance.getParameter('open_cursors')).toBe('300');
  });

  test('undo_management is AUTO', () => {
    expect(db.instance.getParameter('undo_management')).toBe('AUTO');
  });

  test('undo_tablespace is UNDOTBS1', () => {
    expect(db.instance.getParameter('undo_tablespace')).toBe('UNDOTBS1');
  });

  test('undo_retention is 900', () => {
    expect(db.instance.getParameter('undo_retention')).toBe('900');
  });

  test('compatible is 19.0.0', () => {
    expect(db.instance.getParameter('compatible')).toBe('19.0.0');
  });

  test('remote_login_passwordfile is EXCLUSIVE', () => {
    expect(db.instance.getParameter('remote_login_passwordfile')).toBe('EXCLUSIVE');
  });

  test('control_files parameter contains control01.ctl and control02.ctl', () => {
    const val = db.instance.getParameter('control_files');
    expect(val).toContain('control01.ctl');
    expect(val).toContain('control02.ctl');
  });

  test('log_archive_dest_1 contains archivelog path', () => {
    expect(db.instance.getParameter('log_archive_dest_1')).toContain('archivelog');
  });

  test('log_archive_format parameter is set', () => {
    expect(db.instance.getParameter('log_archive_format')).toBe('arch_%t_%s_%r.arc');
  });

  test('db_recovery_file_dest points to fast_recovery_area', () => {
    expect(db.instance.getParameter('db_recovery_file_dest')).toContain('fast_recovery_area');
  });

  test('db_recovery_file_dest_size is 4G', () => {
    expect(db.instance.getParameter('db_recovery_file_dest_size')).toBe('4G');
  });

  test('audit_file_dest parameter is set', () => {
    expect(db.instance.getParameter('audit_file_dest')).toContain('adump');
  });

  test('audit_trail is DB', () => {
    expect(db.instance.getParameter('audit_trail')).toBe('DB');
  });

  test('diagnostic_dest is oracle base', () => {
    expect(db.instance.getParameter('diagnostic_dest')).toBe('/u01/app/oracle');
  });

  test('db_domain is localdomain', () => {
    expect(db.instance.getParameter('db_domain')).toBe('localdomain');
  });
});

// ── NLS Parameters ───────────────────────────────────────────────

describe('NLS Parameters', () => {

  test('nls_language is AMERICAN', () => {
    expect(db.instance.getParameter('nls_language')).toBe('AMERICAN');
  });

  test('nls_territory is AMERICA', () => {
    expect(db.instance.getParameter('nls_territory')).toBe('AMERICA');
  });

  test('nls_date_format is DD-MON-RR', () => {
    expect(db.instance.getParameter('nls_date_format')).toBe('DD-MON-RR');
  });

  test('nls_characterset is AL32UTF8', () => {
    expect(db.instance.getParameter('nls_characterset')).toBe('AL32UTF8');
  });
});

// ── Optimizer Parameters ─────────────────────────────────────────

describe('Optimizer Parameters', () => {

  test('optimizer_mode is ALL_ROWS', () => {
    expect(db.instance.getParameter('optimizer_mode')).toBe('ALL_ROWS');
  });

  test('cursor_sharing is EXACT', () => {
    expect(db.instance.getParameter('cursor_sharing')).toBe('EXACT');
  });
});

// ── SHOW PARAMETER (SQL*Plus) ────────────────────────────────────

describe('SHOW PARAMETER', () => {

  test('SHOW PARAMETER db_name shows parameter with TYPE column', () => {
    const result = session.processLine('SHOW PARAMETER db_name');
    const output = result.output.join('\n');
    expect(output).toContain('NAME');
    expect(output).toContain('TYPE');
    expect(output).toContain('VALUE');
    expect(output).toContain('db_name');
    expect(output).toContain('ORCL');
  });

  test('SHOW PARAMETER processes shows integer type', () => {
    const result = session.processLine('SHOW PARAMETER processes');
    const output = result.output.join('\n');
    expect(output).toContain('integer');
    expect(output).toContain('300');
  });

  test('SHOW PARAMETER sga shows big integer type for memory params', () => {
    const result = session.processLine('SHOW PARAMETER sga_target');
    const output = result.output.join('\n');
    expect(output).toContain('big integer');
  });

  test('SHOW PARAMETER undo shows string type for text params', () => {
    const result = session.processLine('SHOW PARAMETER undo_management');
    const output = result.output.join('\n');
    expect(output).toContain('string');
    expect(output).toContain('AUTO');
  });

  test('SHOW PARAMETERS shows all parameters', () => {
    const result = session.processLine('SHOW PARAMETERS');
    const lines = result.output.filter(l => l.trim().length > 0 && !l.startsWith('-'));
    // Should have header + many parameters
    expect(lines.length).toBeGreaterThan(20);
  });
});

// ── SHOW SPPARAMETER (SQL*Plus) ──────────────────────────────────

describe('SHOW SPPARAMETER', () => {

  test('SHOW SPPARAMETER db_name shows SID column', () => {
    const result = session.processLine('SHOW SPPARAMETER db_name');
    const output = result.output.join('\n');
    expect(output).toContain('SID');
    expect(output).toContain('NAME');
    expect(output).toContain('TYPE');
    expect(output).toContain('VALUE');
    expect(output).toContain('*');
    expect(output).toContain('db_name');
  });

  test('SHOW SPPARAMETER shows all spfile parameters', () => {
    const result = session.processLine('SHOW SPPARAMETER');
    const lines = result.output.filter(l => l.trim().length > 0 && !l.startsWith('-'));
    expect(lines.length).toBeGreaterThan(20);
  });
});

// ── V$PARAMETER View ─────────────────────────────────────────────

describe('V$PARAMETER', () => {

  test('SELECT * FROM V$PARAMETER returns rows with NAME, TYPE, VALUE, DESCRIPTION', () => {
    const result = exec("SELECT NAME, TYPE, VALUE, DESCRIPTION FROM V$PARAMETER WHERE ROWNUM <= 5");
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.columns.map(c => c.name)).toContain('NAME');
    expect(result.columns.map(c => c.name)).toContain('TYPE');
    expect(result.columns.map(c => c.name)).toContain('VALUE');
    expect(result.columns.map(c => c.name)).toContain('DESCRIPTION');
  });

  test('V$PARAMETER includes ISDEFAULT and ISMODIFIED columns', () => {
    const result = exec("SELECT ISDEFAULT, ISMODIFIED FROM V$PARAMETER WHERE ROWNUM <= 1");
    expect(result.columns.map(c => c.name)).toContain('ISDEFAULT');
    expect(result.columns.map(c => c.name)).toContain('ISMODIFIED');
  });

  test('V$PARAMETER shows TRUE for ISDEFAULT on unmodified parameters', () => {
    const result = exec("SELECT * FROM V$PARAMETER WHERE NAME = 'db_name'");
    expect(result.rows.length).toBe(1);
    const colIdx = result.columns.findIndex(c => c.name === 'ISDEFAULT');
    expect(result.rows[0][colIdx]).toBe('TRUE');
  });

  test('V$PARAMETER shows FALSE for ISDEFAULT after ALTER SYSTEM SET', () => {
    exec("ALTER SYSTEM SET open_cursors = 500");
    const result = exec("SELECT * FROM V$PARAMETER WHERE NAME = 'open_cursors'");
    expect(result.rows.length).toBe(1);
    const defaultIdx = result.columns.findIndex(c => c.name === 'ISDEFAULT');
    const modifiedIdx = result.columns.findIndex(c => c.name === 'ISMODIFIED');
    expect(result.rows[0][defaultIdx]).toBe('FALSE');
    expect(result.rows[0][modifiedIdx]).toBe('MODIFIED');
  });

  test('V$PARAMETER includes NUM column', () => {
    const result = exec("SELECT * FROM V$PARAMETER WHERE ROWNUM <= 3");
    expect(result.columns.map(c => c.name)).toContain('NUM');
    const numIdx = result.columns.findIndex(c => c.name === 'NUM');
    expect(result.rows[0][numIdx]).toBeGreaterThan(0);
  });
});

// ── V$SPPARAMETER View ───────────────────────────────────────────

describe('V$SPPARAMETER', () => {

  test('SELECT * FROM V$SPPARAMETER returns rows', () => {
    const result = exec("SELECT SID, NAME, VALUE FROM V$SPPARAMETER WHERE ROWNUM <= 5");
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.columns.map(c => c.name)).toContain('SID');
    expect(result.columns.map(c => c.name)).toContain('NAME');
    expect(result.columns.map(c => c.name)).toContain('VALUE');
  });

  test('V$SPPARAMETER SID is *', () => {
    const result = exec("SELECT * FROM V$SPPARAMETER WHERE ROWNUM <= 1");
    const sidIdx = result.columns.findIndex(c => c.name === 'SID');
    expect(result.rows[0][sidIdx]).toBe('*');
  });

  test('V$SPPARAMETER ISSPECIFIED column is TRUE', () => {
    const result = exec("SELECT * FROM V$SPPARAMETER WHERE ROWNUM <= 1");
    const specIdx = result.columns.findIndex(c => c.name === 'ISSPECIFIED');
    expect(result.rows[0][specIdx]).toBe('TRUE');
  });
});

// ── ALTER SYSTEM SET with SCOPE ──────────────────────────────────

describe('ALTER SYSTEM SET with SCOPE', () => {

  test('ALTER SYSTEM SET param = value updates memory parameter', () => {
    exec("ALTER SYSTEM SET open_cursors = 500");
    expect(db.instance.getParameter('open_cursors')).toBe('500');
  });

  test('ALTER SYSTEM SET with SCOPE=MEMORY only updates memory', () => {
    const originalSpfile = db.instance.getSpfileParameters().get('open_cursors');
    exec("ALTER SYSTEM SET open_cursors = 600 SCOPE = MEMORY");
    expect(db.instance.getParameter('open_cursors')).toBe('600');
    // Spfile should keep original value
    expect(db.instance.getSpfileParameters().get('open_cursors')).toBe(originalSpfile);
  });

  test('ALTER SYSTEM SET with SCOPE=SPFILE only updates spfile', () => {
    const originalMemory = db.instance.getParameter('open_cursors');
    exec("ALTER SYSTEM SET open_cursors = 700 SCOPE = SPFILE");
    // Memory should keep original value
    expect(db.instance.getParameter('open_cursors')).toBe(originalMemory);
    // Spfile should be updated
    expect(db.instance.getSpfileParameters().get('open_cursors')).toBe('700');
  });

  test('ALTER SYSTEM SET with SCOPE=BOTH updates both', () => {
    exec("ALTER SYSTEM SET open_cursors = 800 SCOPE = BOTH");
    expect(db.instance.getParameter('open_cursors')).toBe('800');
    expect(db.instance.getSpfileParameters().get('open_cursors')).toBe('800');
  });

  test('isParameterModified returns true after ALTER SYSTEM SET', () => {
    expect(db.instance.isParameterModified('open_cursors')).toBe(false);
    exec("ALTER SYSTEM SET open_cursors = 500");
    expect(db.instance.isParameterModified('open_cursors')).toBe(true);
  });
});

// ── Spfile Parameters ────────────────────────────────────────────

describe('Spfile Parameters', () => {

  test('getSpfileParameters returns same initial set as getAllParameters', () => {
    const memory = db.instance.getAllParameters();
    const spfile = db.instance.getSpfileParameters();
    // All memory params should exist in spfile
    for (const [key] of memory) {
      expect(spfile.has(key)).toBe(true);
    }
  });

  test('spfile includes db_recovery_file_dest', () => {
    const spfile = db.instance.getSpfileParameters();
    expect(spfile.get('db_recovery_file_dest')).toContain('fast_recovery_area');
  });

  test('spfile includes log_archive_format', () => {
    const spfile = db.instance.getSpfileParameters();
    expect(spfile.get('log_archive_format')).toBe('arch_%t_%s_%r.arc');
  });
});

// ── Alert Log ────────────────────────────────────────────────────

describe('Alert Log', () => {

  test('alert log contains startup entries', () => {
    const log = db.instance.getAlertLog();
    const text = log.join('\n');
    expect(text).toContain('Starting ORACLE instance');
  });

  test('alert log grows after shutdown', () => {
    const beforeCount = db.instance.getAlertLog().length;
    db.instance.shutdown('IMMEDIATE');
    const afterCount = db.instance.getAlertLog().length;
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  test('alert log records archive log mode change', () => {
    // Shutdown and restart to MOUNT
    db.instance.shutdown('IMMEDIATE');
    db.instance.startup('MOUNT');
    db.instance.setArchiveLogMode(true);
    const log = db.instance.getAlertLog();
    const text = log.join('\n');
    expect(text).toContain('Archive log mode enabled');
  });

  test('alert log records log switch', () => {
    db.instance.switchLogfile();
    const log = db.instance.getAlertLog();
    const text = log.join('\n');
    expect(text).toContain('advanced to log sequence');
  });
});

// ── V$SYSTEM_PARAMETER alias ─────────────────────────────────────

describe('V$SYSTEM_PARAMETER', () => {
  test('V$SYSTEM_PARAMETER is alias of V$PARAMETER', () => {
    const result = exec("SELECT * FROM V$SYSTEM_PARAMETER WHERE NAME = 'db_name'");
    expect(result.rows.length).toBe(1);
    const valIdx = result.columns.findIndex(c => c.name === 'VALUE');
    expect(result.rows[0][valIdx]).toBe('ORCL');
  });
});

// ── Additional instance parameters ───────────────────────────────

describe('Additional Parameters (Section 4 completeness)', () => {

  test('local_listener parameter is set', () => {
    expect(db.instance.getParameter('local_listener')).toContain('TCP');
  });

  test('dispatchers parameter is set', () => {
    expect(db.instance.getParameter('dispatchers')).toContain('PROTOCOL');
  });

  test('recyclebin parameter is ON', () => {
    expect(db.instance.getParameter('recyclebin')).toBe('ON');
  });

  test('db_files parameter is set', () => {
    expect(db.instance.getParameter('db_files')).toBe('200');
  });

  test('parallel_max_servers parameter is set', () => {
    expect(db.instance.getParameter('parallel_max_servers')).toBe('40');
  });

  test('resource_limit parameter is TRUE', () => {
    expect(db.instance.getParameter('resource_limit')).toBe('TRUE');
  });

  test('sec_case_sensitive_logon is TRUE', () => {
    expect(db.instance.getParameter('sec_case_sensitive_logon')).toBe('TRUE');
  });

  test('java_pool_size is set', () => {
    expect(db.instance.getParameter('java_pool_size')).toBe('64M');
  });

  test('large_pool_size is set', () => {
    expect(db.instance.getParameter('large_pool_size')).toBe('32M');
  });

  test('db_unique_name is set', () => {
    expect(db.instance.getParameter('db_unique_name')).toBe('ORCL');
  });
});
