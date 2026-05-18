/**
 * Misc SQL*Plus quality-of-life fixes & DDL gaps surfaced by the
 * storage-spaces debug transcript: COMMIT; / ROLLBACK; as single
 * keywords with a trailing semicolon, EXEC, ANALYZE TABLE,
 * ALTER TABLE … MOVE / SHRINK SPACE / ENABLE ROW MOVEMENT,
 * and the BUFFER_POOL column on DBA_SEGMENTS.
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

function s(name: string) {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  return SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
}
const run = (sh: ReturnType<typeof s>, q: string) => sh.processLine(q).output.join('\n');

describe('SQL*Plus single-keyword statements + trailing semicolon', () => {
  it('COMMIT; / ROLLBACK; do not produce SP2-0734', () => {
    const sh = s('commit');
    expect(run(sh, 'COMMIT;')).not.toMatch(/SP2-/);
    expect(run(sh, 'ROLLBACK;')).not.toMatch(/SP2-/);
    sh.dispose();
  });
});

describe('ANALYZE TABLE / EXEC are accepted', () => {
  it('ANALYZE TABLE … COMPUTE STATISTICS returns success', () => {
    const sh = s('analyze');
    const out = run(sh, "CREATE TABLE hr.t (id NUMBER); ANALYZE TABLE hr.t COMPUTE STATISTICS;");
    expect(out).not.toMatch(/SP2-|ORA-/);
    sh.dispose();
  });

  it('EXEC … (anonymous PL/SQL block) is accepted', () => {
    const sh = s('exec');
    const out = run(sh, 'EXEC DBMS_STATS.GATHER_TABLE_STATS(USER, \'HR\');');
    expect(out).not.toMatch(/SP2-/);
    sh.dispose();
  });
});

describe('ALTER TABLE storage operations', () => {
  it('ENABLE / DISABLE ROW MOVEMENT', () => {
    const sh = s('rowmove');
    run(sh, 'CREATE TABLE hr.t (id NUMBER);');
    expect(run(sh, 'ALTER TABLE hr.t ENABLE ROW MOVEMENT;')).toMatch(/Table altered/i);
    expect(run(sh, 'ALTER TABLE hr.t DISABLE ROW MOVEMENT;')).toMatch(/Table altered/i);
    sh.dispose();
  });

  it('SHRINK SPACE [COMPACT|CASCADE]', () => {
    const sh = s('shrink');
    run(sh, 'CREATE TABLE hr.t (id NUMBER);');
    for (const stmt of [
      'ALTER TABLE hr.t SHRINK SPACE;',
      'ALTER TABLE hr.t SHRINK SPACE COMPACT;',
      'ALTER TABLE hr.t SHRINK SPACE CASCADE;',
    ]) {
      expect(run(sh, stmt), `failed: ${stmt}`).toMatch(/Table altered/i);
    }
    sh.dispose();
  });

  it('MOVE TABLESPACE moves the segment to a new tablespace', () => {
    const sh = s('move');
    run(sh, 'CREATE TABLE hr.t (id NUMBER);');
    expect(run(sh, 'ALTER TABLE hr.t MOVE TABLESPACE users;')).toMatch(/Table altered/i);
    const out = run(sh, "SELECT tablespace_name FROM dba_tables WHERE owner='HR' AND table_name='T';");
    expect(out).toContain('USERS');
    sh.dispose();
  });

  it('MOVE COMPRESS FOR QUERY HIGH is accepted', () => {
    const sh = s('compress');
    run(sh, 'CREATE TABLE hr.t (id NUMBER);');
    expect(run(sh, 'ALTER TABLE hr.t MOVE COMPRESS FOR QUERY HIGH;')).toMatch(/Table altered/i);
    sh.dispose();
  });
});

describe('DBA_SEGMENTS column set', () => {
  it('BUFFER_POOL is selectable (real Oracle exposes it)', () => {
    const sh = s('bufpool');
    const out = run(sh, "SELECT owner, segment_name, buffer_pool FROM dba_segments WHERE rownum < 5;");
    expect(out).not.toMatch(/ORA-/);
    expect(out).toMatch(/DEFAULT/);
    sh.dispose();
  });
});
