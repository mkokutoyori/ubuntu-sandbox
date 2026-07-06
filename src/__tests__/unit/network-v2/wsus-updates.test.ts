/**
 * WSUS minimal — PRD-Windows-Server-Advanced.md §5 P19, §2.1.18. A WSUS
 * role maintains a catalog of purely fictional update metadata (KB id,
 * title, category, severity — no binary patch content); a client
 * redirected via `Set-WUSettings -WUServer` queries its deployment group's
 * approved updates over a real TCP connection (port 8530) — approved
 * updates appear in `Get-WindowsUpdate`, declined/undecided ones never do.
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

const ps = (d: WindowsServer | WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

function buildLan() {
  const server = new WindowsServer('WSUS1');
  const client = new WindowsPC('windows-client', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.97.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.97.20'), mask);
  server.setCurrentUser('Administrator');
  return { server, client };
}

describe('WSUS (§5 P19)', () => {
  it('Get-WsusUpdate is refused before the UpdateServices role is installed', async () => {
    const { server } = buildLan();
    const out = await run(ps(server), 'Get-WsusUpdate');
    expect(out).toMatch(/not recognized/);
  });

  it('lists the seeded fictional catalog once the role is installed', async () => {
    const { server } = buildLan();
    await run(ps(server), 'Install-WindowsFeature UpdateServices');
    const out = await run(ps(server), 'Get-WsusUpdate | Select-Object -ExpandProperty KB');
    expect(out).toContain('KB5001330');
  });

  it('an update approved for Install on a client\'s target group appears in Get-WindowsUpdate; a declined one never does', async () => {
    const { server, client } = buildLan();
    await run(ps(server), 'Install-WindowsFeature UpdateServices');
    await run(ps(server), 'Approve-WsusUpdate -Updates KB5001330 -TargetGroupName Workstations -Action Install');
    await run(ps(server), 'Approve-WsusUpdate -Updates KB5002100 -TargetGroupName Workstations -Action Decline');

    await run(ps(client), 'Set-WUSettings -WUServer 192.168.97.10 -TargetGroup Workstations');
    const out = await run(ps(client), 'Get-WindowsUpdate | Select-Object -ExpandProperty KB');

    expect(out).toContain('KB5001330');
    expect(out).not.toContain('KB5002100');
    // Never approved for any group, and never installed by default either.
    expect(out).not.toContain('KB5003200');
  });

  it('a client with no WUServer configured sees no updates', async () => {
    const { client } = buildLan();
    const out = await run(ps(client), 'Get-WindowsUpdate | Measure-Object | Select-Object -ExpandProperty Count');
    expect(out.trim()).toBe('0');
  });

  it('a client in a different target group does not see updates approved for another group', async () => {
    const { server, client } = buildLan();
    await run(ps(server), 'Install-WindowsFeature UpdateServices');
    await run(ps(server), 'Approve-WsusUpdate -Updates KB5001330 -TargetGroupName Servers -Action Install');

    await run(ps(client), 'Set-WUSettings -WUServer 192.168.97.10 -TargetGroup Workstations');
    const out = await run(ps(client), 'Get-WindowsUpdate | Measure-Object | Select-Object -ExpandProperty Count');
    expect(out.trim()).toBe('0');
  });
});
