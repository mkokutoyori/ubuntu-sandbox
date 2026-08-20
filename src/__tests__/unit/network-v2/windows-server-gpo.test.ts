/**
 * PRD-Windows-Server.md §5 P10 — GPO minimal: Default Domain Policy
 * (password/lockout policy) applied to domain members in place of their
 * local `WindowsAccountsPolicy`, `gpupdate /force` (real network pull),
 * `gpresult /r` (RSoP text), and `Get-GPO`/`New-GPO`/`New-GPLink`.
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

async function buildLan() {
  const dc = new WindowsServer('DC1');
  const client = new WindowsPC('windows-pc', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.91.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.91.20'), mask);
  dc.setCurrentUser('Administrator');
  client.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
  dc.installADDSForest('lab.local', 'LAB', 'P@ssw0rd');
  return { dc, client };
}

describe('Get-GPO / New-GPO / New-GPLink', () => {
  it('Get-GPO lists the auto-provisioned Default Domain Policy', async () => {
    const { dc } = await buildLan();
    const out = await run(ps(dc), 'Get-GPO -Name "Default Domain Policy"');
    expect(out).toContain('Default Domain Policy');
  });

  it('is not recognized on a non-DC (New-GPO requires a domain controller)', async () => {
    const { client } = await buildLan();
    const out = await run(ps(client), 'New-GPO -Name "Extra Policy"');
    expect(out).toMatch(/not recognized/i);
  });

  it('New-GPO + New-GPLink links a new policy to the domain', async () => {
    const { dc } = await buildLan();
    await run(ps(dc), 'New-GPO -Name "Extra Policy"');
    await run(ps(dc), 'New-GPLink -Name "Extra Policy"');
    const out = await run(ps(dc), 'Get-GPO -Name "Extra Policy"');
    expect(out).toContain('DC=lab,DC=local');
  });
});

describe('gpupdate /force — real network pull applies Default Domain Policy', () => {
  it('overrides the local WindowsAccountsPolicy on a domain-joined client', async () => {
    const { client } = await buildLan();
    const before = await run(ps(client), 'net accounts');
    expect(before).toContain('Minimum password length:                              0');

    client.joinDomainNow('lab.local', '192.168.91.10', 'Administrator', 'P@ssw0rd');
    const out = await client.executeCmdCommand('gpupdate /force');
    expect(out).toMatch(/completed successfully/i);

    const after = await run(ps(client), 'net accounts');
    expect(after).toContain('Minimum password length:                              7');
    expect(after).toContain('Lockout threshold:                                    5');
  });

  it('fails cleanly when not domain-joined', async () => {
    const { client } = await buildLan();
    const out = await client.executeCmdCommand('gpupdate /force');
    expect(out).toMatch(/not joined to a domain/i);
  });
});

describe('gpresult /r — RSoP text', () => {
  it('shows the applied GPO name after gpupdate', async () => {
    const { dc, client } = await buildLan();
    client.joinDomainNow('lab.local', '192.168.91.10', 'Administrator', 'P@ssw0rd');
    await client.executeCmdCommand('gpupdate /force');

    const out = await client.executeCmdCommand('gpresult /r');
    expect(out).toContain('Default Domain Policy');
    expect(out).toContain('LAB');
    void dc;
  });

  it('shows a linked custom GPO\'s logon banner', async () => {
    const { dc, client } = await buildLan();
    const store = dc.getDirectoryStore()!;
    store.newGpo('Legal Notice Policy');
    store.setGpoSettings('Legal Notice Policy', { logonBanner: { title: 'Notice', text: 'Authorized use only.' } });
    store.newGPLink('Legal Notice Policy', store.getDomainDn());

    client.joinDomainNow('lab.local', '192.168.91.10', 'Administrator', 'P@ssw0rd');
    await client.executeCmdCommand('gpupdate /force');

    const out = await client.executeCmdCommand('gpresult /r');
    expect(out).toContain('Legal Notice Policy');
    expect(out).toContain('Authorized use only.');
  });
});
