/**
 * Print Services / LPD — PRD-Windows-Server-Advanced.md §5 P20, §2.1.19,
 * RFC 1179. `Add-Printer -ShareName` exposes a shared queue reachable from
 * a remote host via LPD (real byte framing: opcode + operand lines,
 * zero-byte acks, count-prefixed file transfers, port 515). No document
 * is ever rendered — only the acknowledgement/queue-progression state
 * `Get-PrintJob`/`Remove-PrintJob` expose is modeled.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

function buildLan() {
  const server = new WindowsServer('PRINTSRV');
  const client = new WindowsPC('windows-client', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.98.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.98.20'), mask);
  server.setCurrentUser('Administrator');
  client.setCurrentUser('alice');
  return { server, client };
}

describe('Print Services / LPD (§5 P20)', () => {
  it('Add-Printer is refused before Print-Services is installed', async () => {
    const { server } = buildLan();
    const out = await run(ps(server), 'Add-Printer -ShareName SharedLaser');
    expect(out).toMatch(/not recognized/);
  });

  it('a job submitted via lpr from a remote host appears in the shared queue with the correct progress status', async () => {
    const { server, client } = buildLan();
    await run(ps(server), 'Install-WindowsFeature Print-Services');
    await run(ps(server), 'Add-Printer -ShareName SharedLaser');

    client.getFileSystem().createFile('C:\\report.txt', 'quarterly numbers');
    const lprOut = await client.executeCmdCommand('lpr -S 192.168.98.10 -P SharedLaser C:\\report.txt');
    expect(lprOut.trim()).toBe('');

    const jobsOut = await run(ps(server), 'Get-PrintJob -PrinterName SharedLaser | Select-Object -ExpandProperty DocumentName');
    expect(jobsOut).toContain('C:\\report.txt');

    const statusOut = await run(ps(server), 'Get-PrintJob -PrinterName SharedLaser | Select-Object -ExpandProperty JobStatus');
    expect(statusOut.trim()).toBe('Printing');

    const ownerOut = await run(ps(server), 'Get-PrintJob -PrinterName SharedLaser | Select-Object -ExpandProperty SubmittedBy');
    expect(ownerOut.trim()).toBe('alice');
  });

  it('lpr against a queue that does not exist fails, and no job is queued', async () => {
    const { server, client } = buildLan();
    await run(ps(server), 'Install-WindowsFeature Print-Services');
    await run(ps(server), 'Add-Printer -ShareName SharedLaser');

    client.getFileSystem().createFile('C:\\report.txt', 'quarterly numbers');
    const lprOut = await client.executeCmdCommand('lpr -S 192.168.98.10 -P GhostQueue C:\\report.txt');
    expect(lprOut).toMatch(/does not exist/);

    const jobsOut = await run(ps(server), 'Get-PrintJob -PrinterName SharedLaser | Measure-Object | Select-Object -ExpandProperty Count');
    expect(jobsOut.trim()).toBe('0');
  });

  it('Remove-PrintJob removes a queued job by ID', async () => {
    const { server, client } = buildLan();
    await run(ps(server), 'Install-WindowsFeature Print-Services');
    await run(ps(server), 'Add-Printer -ShareName SharedLaser');

    client.getFileSystem().createFile('C:\\report.txt', 'quarterly numbers');
    await client.executeCmdCommand('lpr -S 192.168.98.10 -P SharedLaser C:\\report.txt');

    const idOut = await run(ps(server), 'Get-PrintJob -PrinterName SharedLaser | Select-Object -ExpandProperty ID');
    await run(ps(server), `Remove-PrintJob -PrinterName SharedLaser -ID ${idOut.trim()}`);

    const jobsOut = await run(ps(server), 'Get-PrintJob -PrinterName SharedLaser | Measure-Object | Select-Object -ExpandProperty Count');
    expect(jobsOut.trim()).toBe('0');
  });
});
