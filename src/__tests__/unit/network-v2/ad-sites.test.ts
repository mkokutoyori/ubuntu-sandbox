/**
 * PRD-Windows-Server-Advanced.md §5 P6 — AD Sites (metadata only):
 * `New-ADReplicationSite`/`Get-ADReplicationSite`/`New-ADReplicationSubnet`
 * define named sites and their subnets; a DC's site is derived from its
 * IP falling inside one of those subnets, and used only to annotate a
 * replication cycle as "intra-site" or "inter-site" — no real link-cost
 * computation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
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

async function buildTwoDcs(): Promise<{ dc1: WindowsServer; dc2: WindowsServer }> {
  const dc1 = new WindowsServer('DC1');
  const dc2 = new WindowsServer('DC2');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc1').connect(dc1.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-dc2').connect(dc2.getPorts()[0], sw.getPorts()[1]);
  const bothDcsOnOneRouterlessSegment = new SubnetMask('255.255.0.0');
  dc1.getPorts()[0].configureIP(new IPAddress('192.168.80.10'), bothDcsOnOneRouterlessSegment);
  dc2.getPorts()[0].configureIP(new IPAddress('192.168.81.10'), bothDcsOnOneRouterlessSegment);

  dc1.setCurrentUser('Administrator');
  await run(ps(dc1), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc1), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');

  dc2.setCurrentUser('Administrator');
  await run(ps(dc2), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc2), 'Install-ADDSDomainController -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.80.10 '
    + '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  return { dc1, dc2 };
}

describe('AD Sites — New/Get-ADReplicationSite, New-ADReplicationSubnet', () => {
  it('auto-creates Default-First-Site-Name at forest creation', async () => {
    const dc1 = new WindowsServer('DC1');
    dc1.setCurrentUser('Administrator');
    await run(ps(dc1), 'Install-WindowsFeature AD-Domain-Services');
    await run(ps(dc1), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');

    const out = await run(ps(dc1), 'Get-ADReplicationSite');
    expect(out).toContain('Default-First-Site-Name');
  });

  it('creates a new named site with New-ADReplicationSite', async () => {
    const dc1 = new WindowsServer('DC1');
    dc1.setCurrentUser('Administrator');
    await run(ps(dc1), 'Install-WindowsFeature AD-Domain-Services');
    await run(ps(dc1), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');

    await run(ps(dc1), 'New-ADReplicationSite -Name Branch-Office');
    const out = await run(ps(dc1), 'Get-ADReplicationSite');
    expect(out).toContain('Branch-Office');
    expect(out).toContain('Default-First-Site-Name');
  });

  it('rejects a duplicate site name', async () => {
    const dc1 = new WindowsServer('DC1');
    dc1.setCurrentUser('Administrator');
    await run(ps(dc1), 'Install-WindowsFeature AD-Domain-Services');
    await run(ps(dc1), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');

    await run(ps(dc1), 'New-ADReplicationSite -Name Branch-Office');
    const out = await run(ps(dc1), 'New-ADReplicationSite -Name Branch-Office');
    expect(out).toMatch(/already exists/);
  });
});

describe('AD Sites — replication log annotates intra-/inter-site', () => {
  it('logs "intra-site" when both DCs are in the default site (no subnets defined)', async () => {
    const { dc2 } = await buildTwoDcs();
    dc2.replicateFrom('192.168.80.10');
    const log = dc2.getReplicationLog();
    expect(log.length).toBeGreaterThan(0);
    expect(log[log.length - 1].siteRelation).toBe('intra-site');
  });

  it('logs "inter-site" once each DC is explicitly moved (Move-ADDirectoryServer) to a distinct site', async () => {
    const { dc1, dc2 } = await buildTwoDcs();
    await run(ps(dc1), 'New-ADReplicationSite -Name Branch-Office');
    await run(ps(dc1), 'New-ADReplicationSubnet -Name "192.168.80.0/24" -Site Default-First-Site-Name');
    await run(ps(dc1), 'New-ADReplicationSubnet -Name "192.168.81.0/24" -Site Branch-Office');
    // A DC's site membership is explicit/sticky at promotion — a subnet
    // defined afterwards doesn't retroactively move an already-promoted
    // DC (that's exactly what Move-ADDirectoryServer is for in real AD).
    await run(ps(dc1), 'Move-ADDirectoryServer -Identity DC2.lab.local -Site Branch-Office');

    dc2.replicateFrom('192.168.80.10'); // pulls the new site/subnet/server definitions too
    const log = dc2.getReplicationLog();
    expect(log[log.length - 1].siteRelation).toBe('inter-site');
  });

  it('logs "intra-site" when both DCs fall in the same explicitly-defined site/subnet', async () => {
    const { dc1, dc2 } = await buildTwoDcs();
    await run(ps(dc1), 'New-ADReplicationSubnet -Name "192.168.80.0/24" -Site Default-First-Site-Name');
    await run(ps(dc1), 'New-ADReplicationSubnet -Name "192.168.81.0/24" -Site Default-First-Site-Name');

    dc2.replicateFrom('192.168.80.10');
    const log = dc2.getReplicationLog();
    expect(log[log.length - 1].siteRelation).toBe('intra-site');
  });
});
