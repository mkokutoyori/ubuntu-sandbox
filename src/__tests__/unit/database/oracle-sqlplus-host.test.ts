/**
 * SQL*Plus HOST / ! — execute host shell commands on the underlying
 * Linux device. Lets users cross-check that files reported by Oracle
 * views (v$datafile, v$controlfile, v$logfile, …) actually exist on
 * the simulated filesystem.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { ORACLE_CONFIG } from '@/database/oracle/OracleConfig';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { SQLPlusSession } from '@/database/oracle/commands/SQLPlusSession';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

describe('SQL*Plus HOST command', () => {
  it('falls back to SP2-0734 when no runner is wired', () => {
    const session = new SQLPlusSession(new OracleDatabase());
    session.login('SYS', '', true);
    const result = session.processLine('HOST ls /');
    expect(result.output.join('\n')).toContain('SP2-0734');
  });

  it('executes a real shell command on the LinuxServer via SqlPlusSubShell', () => {
    const srv = new LinuxServer('linux-server', 'ora-host', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    const out = subShell.processLine(`HOST ls ${ORACLE_CONFIG.ORADATA}`).output.join('\n');
    expect(out).toContain('system01.dbf');
    expect(out).toContain('control01.ctl');
    expect(out).toContain('redo01.log');
    subShell.dispose();
  });

  it('supports the `!` alias for HOST', () => {
    const srv = new LinuxServer('linux-server', 'ora-host-bang', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    const out = subShell.processLine(`!ls ${ORACLE_CONFIG.ORADATA}`).output.join('\n');
    expect(out).toContain('system01.dbf');
    subShell.dispose();
  });

  it('every datafile from v$datafile is reachable via HOST ls', () => {
    const srv = new LinuxServer('linux-server', 'ora-host-cross', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    // Datafiles are listed via the view…
    const dfList = subShell.processLine('SELECT name FROM v$datafile;').output.join('\n');
    const paths = Array.from(dfList.matchAll(/(\/\S+\.dbf)/g)).map(m => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    // …and must each be visible on the host filesystem.
    for (const p of paths) {
      const lsOut = subShell.processLine(`HOST ls ${p}`).output.join('\n');
      expect(lsOut).toContain(p.split('/').pop()!);
    }
    subShell.dispose();
  });

  it('reports an empty HOST command without crashing', () => {
    const srv = new LinuxServer('linux-server', 'ora-host-empty', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    const result = subShell.processLine('HOST');
    expect(result.output.join('\n')).toMatch(/SP2-/);
    subShell.dispose();
  });
});
