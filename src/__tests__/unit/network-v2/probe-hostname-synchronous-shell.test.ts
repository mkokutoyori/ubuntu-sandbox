/*
 * Probe: `hostname` answered "bash: hostname: command not found" on the synchronous shell path (executeShellCommandSync, the one SQL*Plus HOST, the OS context
 * capture of V$SESSION/USERENV and the scripts use), while the interactive path answered the name. Since hostname moved to the command registry its run() was
 * always a Promise, and the synchronous bypass can only take a bare string. The plain `hostname` (no option) is a pure read of the machine name and now returns
 * synchronously; every form that resolves an address (-f, -i, -a, -A, -I) stays asynchronous as before. Measured consequences before the fix: USERENV HOST read
 * "bash: hostname: command not found", and the HOST of V$SESSION too (the machine of the client in the audit trail).
 *
 * Discriminated with git stash on src: 3 of 4 fall before the fix; the async forms (-f) pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances(); Logger.reset(); });

describe('hostname on the synchronous shell path', () => {
  it('witness: the interactive path answers the machine name', async () => {
    expect((await new LinuxServer('linux-server', 'DB1').executeCommand('hostname')).trim()).toBe('DB1');
  });

  it('the synchronous path answers it too', () => {
    expect(new LinuxServer('linux-server', 'DB1').executeShellCommandSync('hostname').trim()).toBe('DB1');
  });

  it('a renamed machine is read at the time of the call', async () => {
    const server = new LinuxServer('linux-server', 'DB1');
    await server.executeCommand('hostnamectl set-hostname ora-prd');
    expect(server.executeShellCommandSync('hostname').trim()).toBe('ora-prd');
  });

  it('SQL*Plus reports the machine as the client host in USERENV', () => {
    const server = new LinuxServer('linux-server', 'DB1');
    const shell = SqlPlusSubShell.create(server, ['/', 'as', 'sysdba']).subShell;
    const output = shell.processLine("SELECT SYS_CONTEXT('USERENV','HOST') AS host FROM dual;").output.join('\n');
    expect(output).toContain('DB1');
    expect(output).not.toContain('command not found');
    shell.dispose();
  });
});
