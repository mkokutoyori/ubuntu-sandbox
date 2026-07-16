/**
 * Instance-lifecycle gaps surfaced by the debug dump:
 *  - V\$INSTANCE column extensions (PARALLEL, ARCHIVER, LOGINS,
 *    ACTIVE_STATE, LOG_SWITCH_WAIT)
 *  - V\$PARAMETER ISSYS_MODIFIABLE / ISSES_MODIFIABLE
 *  - STARTUP UPGRADE / OPEN RECOVER / MOUNT RESTRICT EXCLUSIVE
 *  - V\$RECOVERY_STATUS, V\$TIMEZONE_FILE (empty views)
 *  - ALTER SYSTEM SET EVENTS '…' — accepted form without '='
 *  - ORADEBUG SQL\*Plus command — accepted and no-op
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

describe('V$INSTANCE column extensions', () => {
  it('PARALLEL / ARCHIVER / LOGINS / ACTIVE_STATE / LOG_SWITCH_WAIT all selectable', async () => {
    const sh = s('vinst');
    const out = (await run(sh,
      'SELECT instance_name, host_name, version, startup_time, status, ' +
      'parallel, archiver, logins, active_state, log_switch_wait FROM v$instance;'
    ));
    expect(out).not.toMatch(/ORA-/);
    expect(out).toMatch(/ORCL/);
    sh.dispose();
  });
});

describe('V$PARAMETER modifiability columns', () => {
  it('ISSYS_MODIFIABLE / ISSES_MODIFIABLE selectable', async () => {
    const sh = s('vparam');
    expect((await run(sh, 'SELECT name, value, issys_modifiable, isses_modifiable FROM v$parameter;'))).not.toMatch(/ORA-/);
    sh.dispose();
  });
});

describe('STARTUP variants parse', () => {
  it.each([
    'STARTUP UPGRADE',
    'STARTUP OPEN RECOVER',
    'STARTUP MOUNT RESTRICT EXCLUSIVE',
  ])('%s does not throw', async (cmd) => {
    const sh = s(`startup-${cmd.replace(/\s+/g, '-')}`);
    (await run(sh, 'SHUTDOWN IMMEDIATE'));
    const out = (await run(sh, cmd));
    expect(out).not.toMatch(/SP2-|invalid SQL/);
    sh.dispose();
  });
});

describe('Missing views — empty, parseable', () => {
  it.each(['V$RECOVERY_STATUS', 'V$TIMEZONE_FILE'])('SELECT * FROM %s', async (v) => {
    const sh = s(`v-${v}`);
    expect((await run(sh, `SELECT * FROM ${v};`))).not.toMatch(/ORA-00942/);
    sh.dispose();
  });
});

describe('ALTER SYSTEM SET EVENTS … parses without "="', () => {
  it("'942 trace name errorstack level 3'", async () => {
    const sh = s('events');
    expect((await run(sh, "ALTER SYSTEM SET EVENTS '942 trace name errorstack level 3';")))
      .toMatch(/System altered/i);
    sh.dispose();
  });
});

describe('ORADEBUG SQL*Plus command', () => {
  it.each([
    'ORADEBUG SETMYPID',
    'ORADEBUG DUMP SYSTEMSTATE 10',
    'ORADEBUG DUMP HANGANALYZE 3',
    'ORADEBUG TRACEFILE_NAME',
  ])('%s does not emit SP2-0734', async (cmd) => {
    const sh = s(`oradbg-${cmd.replace(/\s+/g, '-')}`);
    const out = (await run(sh, cmd + ';'));
    expect(out).not.toMatch(/SP2-/);
    sh.dispose();
  });
});
