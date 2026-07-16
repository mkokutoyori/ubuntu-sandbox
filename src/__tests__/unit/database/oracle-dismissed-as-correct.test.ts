/**
 * Verifies that every gap I previously dismissed as "ORA-XXXXX is the
 * correct response" really does produce the right behaviour when the
 * input conditions are met. Each `it` exercises the *happy path* the
 * dump never reached.
 *
 * Failures here flag features that were actually broken, not just
 * wrong-input victims.
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
const run = async (sh: ReturnType<typeof s>, q: string) => (await sh.processLine(q)).output.join('\n');

describe('SHUTDOWN variants happy path', () => {
  it.each(['SHUTDOWN', 'SHUTDOWN IMMEDIATE', 'SHUTDOWN ABORT', 'SHUTDOWN TRANSACTIONAL'])
    ('on a fresh OPEN instance, %s succeeds', async (cmd) => {
    const sh = s(`shut-${cmd.replace(/\s+/g, '-')}`);
    const out = (await run(sh, cmd + ';'));
    expect(out).not.toMatch(/ORA-01034/);
    expect(out).toMatch(/Database closed|ORACLE instance shut down/i);
    sh.dispose();
  });
});

describe('CONNECT BY LEVEL <= N really generates N rows', () => {
  it('SELECT level FROM dual CONNECT BY level <= 5 → 5 rows', async () => {
    const sh = s('cb1');
    const out = (await run(sh, 'SELECT level FROM dual CONNECT BY level <= 5;'));
    expect(out).not.toMatch(/ORA-/);
    expect(out).toMatch(/5 rows selected/i);
    for (let n = 1; n <= 5; n++) expect(out).toContain(String(n));
    sh.dispose();
  });

  it('INSERT … SELECT level CONNECT BY level <= N populates the table', async () => {
    const sh = s('cb2');
    (await run(sh, 'CREATE TABLE hr.t (id NUMBER);'));
    (await run(sh, 'INSERT INTO hr.t SELECT level FROM dual CONNECT BY level <= 10;'));
    const cnt = (await run(sh, 'SELECT COUNT(*) FROM hr.t;'));
    expect(cnt).toMatch(/\b10\b/);
    sh.dispose();
  });
});

describe('Auto-generated primary-key index (SYS_C<n>)', () => {
  it('CREATE TABLE … (id NUMBER PRIMARY KEY) creates an index discoverable in dba_indexes', async () => {
    const sh = s('autoidx');
    (await run(sh, 'CREATE TABLE hr.t (id NUMBER PRIMARY KEY, name VARCHAR2(50));'));
    const out = (await run(sh, "SELECT index_name FROM dba_indexes WHERE owner='HR' AND table_name='T';"));
    // Real Oracle names it SYS_C00<number>.
    expect(out).toMatch(/SYS_C\d+/);
    sh.dispose();
  });

  it('ALTER INDEX <auto_pk_index> REBUILD succeeds (using the real generated name)', async () => {
    const sh = s('autoidx2');
    (await run(sh, 'CREATE TABLE hr.t (id NUMBER PRIMARY KEY);'));
    const list = (await run(sh, "SELECT index_name FROM dba_indexes WHERE owner='HR' AND table_name='T';"));
    const name = list.match(/SYS_C\d+/)?.[0];
    expect(name).toBeDefined();
    expect((await run(sh, `ALTER INDEX hr.${name} REBUILD ONLINE;`))).toMatch(/Index altered/i);
    sh.dispose();
  });
});

describe('ALTER DISKGROUP happy path (when the diskgroup actually exists)', () => {
  it('ADD DISK against an existing diskgroup succeeds', async () => {
    const sh = s('dg-happy');
    (await run(sh, "CREATE DISKGROUP DATA EXTERNAL REDUNDANCY DISK '/dev/sda1' SIZE 100 M;"));
    expect((await run(sh, "ALTER DISKGROUP DATA ADD DISK '/dev/sda2' SIZE 100 M;")))
      .toMatch(/Diskgroup altered/i);
    sh.dispose();
  });
});

describe('v$diag_problem.INCIDENT_COUNT (real Oracle name) is queryable', () => {
  it('selectable without ORA-00904', async () => {
    const sh = s('vdp');
    expect((await run(sh, 'SELECT problem_key, incident_count FROM v$diag_problem;'))).not.toMatch(/ORA-/);
    sh.dispose();
  });
});

describe('v$system_event.EVENT (real Oracle name) is queryable', () => {
  it('selectable without ORA-00904', async () => {
    const sh = s('vse');
    expect((await run(sh, "SELECT event, total_waits FROM v$system_event WHERE event LIKE 'log file%';")))
      .not.toMatch(/ORA-/);
    sh.dispose();
  });
});
