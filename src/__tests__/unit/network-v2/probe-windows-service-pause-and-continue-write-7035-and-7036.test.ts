/*
 * Probe: Suspend-Service / `sc pause` and Resume-Service / `sc continue` changed the state of a service and wrote nothing, so the
 * Paused state appeared in no log. Sources (rule 8): Microsoft Learn "Event ID 7035" and "Event ID 7036 -- Basic Service Operations"
 * (Windows Server 2008 R2, read in this session): 7035 "The %1 service was successfully sent a %2 control." and 7036 "The %1 service
 * entered the %2 state." Those pages give the templates, not the %2 values. The values come from captured logs, which outrank the
 * documentation: a Windows Server 2003 System log excerpt (atmarkit.itmedia.co.jp, eventlog02_02) shows the 7035 of a pause
 * ("...sent a pause control", rendered in Japanese as the pause control), and the 7035 text of a paused Net Logon service is quoted on
 * a forum (neowin.net topic 656298). The words "pause", "continue", "paused" and "running" are therefore the ones the captured logs
 * carry; the "continue" control and the return to "running" are the symmetric entries of the same transcripts, not read on a page of
 * their own. Said in TODO.md.
 *
 * Discriminated with git stash on src/network: 4 of 6 fall before the fix; two pass either way and are named: the witness (the
 * service is paused) and "a refused pause writes nothing" (nothing was written for anything).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

async function machine() {
  const server = new WindowsServer('SRV1');
  server.setCurrentUser('Administrator');
  const sh = PowerShellSubShell.create(server).subShell;
  const run = async (line: string) => (await sh.processLine(line)).output.join('\n').trim();
  return { server, run };
}

const events = (run: (line: string) => Promise<string>, id: number) =>
  run(`Get-WinEvent -FilterHashtable @{LogName="System"; Id=${id}} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Message`);

describe('pausing and continuing a service', () => {
  it('witness: Suspend-Service pauses the service', async () => {
    const { run } = await machine();
    await run('Suspend-Service -Name LanmanServer');
    expect(await run('(Get-Service -Name LanmanServer).Status')).toBe('Paused');
  });

  it('Suspend-Service writes 7035 with the pause control', async () => {
    const { run } = await machine();
    await run('Suspend-Service -Name LanmanServer');
    expect(await events(run, 7035)).toContain('The Server service was successfully sent a pause control.');
  });

  it('and 7036 with the paused state', async () => {
    const { run } = await machine();
    await run('Suspend-Service -Name LanmanServer');
    expect(await events(run, 7036)).toContain('The Server service entered the paused state.');
  });

  it('Resume-Service writes 7035 with the continue control and 7036 with the running state', async () => {
    const { run } = await machine();
    await run('Suspend-Service -Name LanmanServer');
    await run('Resume-Service -Name LanmanServer');
    expect(await events(run, 7035)).toContain('The Server service was successfully sent a continue control.');
    expect(await events(run, 7036)).toContain('The Server service entered the running state.');
  });

  it('sc pause and sc continue write the same events', async () => {
    const { server, run } = await machine();
    await server.executeCmdCommand('sc pause LanmanServer');
    await server.executeCmdCommand('sc continue LanmanServer');
    expect(await events(run, 7035)).toContain('successfully sent a pause control.');
    expect(await events(run, 7035)).toContain('successfully sent a continue control.');
  });

  it('a refused pause (a service that cannot be paused) writes nothing', async () => {
    const { run } = await machine();
    await run('Suspend-Service -Name Dhcp -ErrorAction SilentlyContinue');
    expect(await events(run, 7035)).not.toContain('pause control');
  });
});
