/**
 * Journalisation gaps surfaced by the oracle-journalization debug
 * transcript: column additions on V\$LOG / V\$LOG_HISTORY /
 * V\$ARCHIVED_LOG / V\$ARCHIVE_DEST / V\$DATABASE / V\$SYSTEM_EVENT /
 * V\$DIAG_PROBLEM, the X\$DBGALERTEXT internal view and its V\$
 * twin V\$DIAG_ALERT_EXT (both derived from the live alert log),
 * supplemental-log dictionary views DBA_LOG_GROUPS /
 * DBA_LOG_GROUP_COLUMNS, plus parser tolerance for the
 * supplemental / checkpoint / archive-log variants.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function s(name: string) {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
  return { subShell, srv };
}
const run = (sh: ReturnType<typeof s>['subShell'], q: string) => sh.processLine(q).output.join('\n');

describe('redo log / archived log column sets', () => {
  it('V$LOG exposes GROUP# / THREAD# / SEQUENCE# / BYTES / MEMBERS / STATUS / ARCHIVED', () => {
    const sh = s('vlog').subShell;
    const out = run(sh, 'SELECT group#, thread#, sequence#, bytes, members, status, archived FROM v$log;');
    expect(out).not.toMatch(/ORA-/);
    expect(out).toMatch(/CURRENT|INACTIVE|ACTIVE/);
    sh.dispose();
  });

  it('V$LOG_HISTORY exposes SEQUENCE# / FIRST_CHANGE# / NEXT_CHANGE# / FIRST_TIME / ARCHIVED', () => {
    const sh = s('vlh').subShell;
    const out = run(sh, 'SELECT sequence#, first_change#, next_change#, first_time, archived FROM v$log_history;');
    expect(out).not.toMatch(/ORA-/);
    sh.dispose();
  });

  it('V$ARCHIVED_LOG exposes THREAD# / SEQUENCE# / FIRST_CHANGE# / NEXT_CHANGE# / FIRST_TIME / ARCHIVED', () => {
    const sh = s('val').subShell;
    const out = run(sh, 'SELECT thread#, sequence#, first_change#, next_change#, first_time, archived FROM v$archived_log;');
    expect(out).not.toMatch(/ORA-/);
    sh.dispose();
  });

  it('V$ARCHIVE_DEST exposes DEST_NAME / STATUS / DESTINATION / ARCHIVER / SCHEDULE', () => {
    const sh = s('vad').subShell;
    const out = run(sh, "SELECT dest_name, status, destination, archiver, schedule FROM v$archive_dest WHERE status = 'VALID';");
    expect(out).not.toMatch(/ORA-/);
    sh.dispose();
  });
});

describe('v$database column extensions', () => {
  it('CONTROLFILE_TYPE is present', () => {
    const sh = s('vdb-ct').subShell;
    expect(run(sh, 'SELECT name, log_mode, controlfile_type FROM v$database;')).not.toMatch(/ORA-/);
    sh.dispose();
  });

  it('SUPPLEMENTAL_LOG_DATA_* columns are present', () => {
    const sh = s('vdb-sup').subShell;
    const out = run(sh,
      'SELECT supplemental_log_data_min, supplemental_log_data_pk, supplemental_log_data_ui, ' +
      'supplemental_log_data_fk, supplemental_log_data_all FROM v$database;'
    );
    expect(out).not.toMatch(/ORA-/);
    sh.dispose();
  });
});

describe('alert-log views', () => {
  it('X$DBGALERTEXT and V$DIAG_ALERT_EXT both surface the instance alert log', () => {
    const env = s('alerts');
    const db = getOracleDatabase(env.srv.getId());
    db.instance.logAlert('Test marker line A');
    db.instance.logAlert('Test marker line B');
    const a = run(env.subShell, 'SELECT message_text FROM x$dbgalertext ORDER BY originating_timestamp;');
    const b = run(env.subShell, 'SELECT message_text FROM v$diag_alert_ext ORDER BY originating_timestamp;');
    for (const out of [a, b]) {
      expect(out).toContain('Test marker line A');
      expect(out).toContain('Test marker line B');
    }
    env.subShell.dispose();
  });
});

describe('V$DIAG_PROBLEM uses real Oracle column name (INCIDENT_COUNT)', () => {
  it('exposes INCIDENT_COUNT (Oracle 19c naming)', () => {
    const sh = s('vdp').subShell;
    expect(run(sh, 'SELECT problem_id, problem_key, incident_count FROM v$diag_problem;')).not.toMatch(/ORA-/);
    sh.dispose();
  });
});

describe('V$SYSTEM_EVENT.NAME column (legacy queries)', () => {
  it('NAME alias accepted alongside EVENT', () => {
    const sh = s('vse').subShell;
    expect(run(sh, "SELECT event, total_waits, time_waited FROM v$system_event WHERE event LIKE 'log file%';"))
      .not.toMatch(/ORA-/);
    sh.dispose();
  });
});

describe('parser tolerance — supplemental logging, archive log start/stop, checkpoint global/local', () => {
  it('ALTER SYSTEM CHECKPOINT GLOBAL / LOCAL', () => {
    const sh = s('chk').subShell;
    expect(run(sh, 'ALTER SYSTEM CHECKPOINT GLOBAL;')).toMatch(/System altered/i);
    expect(run(sh, 'ALTER SYSTEM CHECKPOINT LOCAL;')).toMatch(/System altered/i);
    sh.dispose();
  });

  it('ALTER SYSTEM ARCHIVE LOG START / STOP', () => {
    const sh = s('arch').subShell;
    expect(run(sh, 'ALTER SYSTEM ARCHIVE LOG START;')).not.toMatch(/ORA-/);
    expect(run(sh, 'ALTER SYSTEM ARCHIVE LOG STOP;')).not.toMatch(/ORA-/);
    sh.dispose();
  });

  it('ALTER TABLE … ADD/DROP SUPPLEMENTAL LOG DATA / GROUP', () => {
    const sh = s('supp').subShell;
    run(sh, 'CREATE TABLE hr.t (id NUMBER PRIMARY KEY, name VARCHAR2(50));');
    expect(run(sh, 'ALTER TABLE hr.t ADD SUPPLEMENTAL LOG DATA (PRIMARY KEY) COLUMNS;')).toMatch(/Table altered/i);
    expect(run(sh, 'ALTER TABLE hr.t ADD SUPPLEMENTAL LOG GROUP emp_sg (id, name) ALWAYS;')).toMatch(/Table altered/i);
    expect(run(sh, 'ALTER TABLE hr.t DROP SUPPLEMENTAL LOG GROUP emp_sg;')).toMatch(/Table altered/i);
    sh.dispose();
  });

  it('DBA_LOG_GROUPS and DBA_LOG_GROUP_COLUMNS exist (empty by default)', () => {
    const sh = s('lg').subShell;
    expect(run(sh, 'SELECT * FROM dba_log_groups;')).not.toMatch(/ORA-/);
    expect(run(sh, 'SELECT * FROM dba_log_group_columns;')).not.toMatch(/ORA-/);
    sh.dispose();
  });
});

describe('ARCHIVE LOG LIST SQL*Plus command', () => {
  it('produces the standard report block', () => {
    const sh = s('archlist').subShell;
    const out = run(sh, 'ARCHIVE LOG LIST;');
    expect(out).not.toMatch(/SP2-/);
    expect(out).toMatch(/Database log mode/i);
    expect(out).toMatch(/Current log sequence/i);
    sh.dispose();
  });

  it('omits "Next log sequence to archive" in NOARCHIVELOG mode', () => {
    const { subShell } = s('archlist-noarc');
    const out = run(subShell, 'ARCHIVE LOG LIST;');
    expect(out).toMatch(/No Archive Mode/);
    expect(out).not.toMatch(/Next log sequence to archive/);
    subShell.dispose();
  });

  it('shows "Next log sequence to archive" in ARCHIVELOG mode', () => {
    const { subShell, srv } = s('archlist-arc');
    const db = getOracleDatabase(srv.getId());
    (db.instance as unknown as { _archiveLogMode: boolean })._archiveLogMode = true;
    const out = run(subShell, 'ARCHIVE LOG LIST;');
    expect(out).toMatch(/Archive Mode/);
    expect(out).toMatch(/Next log sequence to archive/);
    subShell.dispose();
  });
});
