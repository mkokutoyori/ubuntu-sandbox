/**
 * PRD-Windows-Server-Advanced.md §5 P5 — `Install-ADDSDomainController`:
 * promotes a second server as an additional DC of an existing domain, via
 * a real LDAP reachability/credential check and a real initial
 * replication sync (§5 P4) — not an independent `Install-ADDSForest` for
 * the same domain name. `Get-ADDomainController` reflects the result.
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

async function buildFirstDc(): Promise<{ dc1: WindowsServer; dc2: WindowsServer }> {
  const dc1 = new WindowsServer('DC1');
  const dc2 = new WindowsServer('DC2');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc1').connect(dc1.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-dc2').connect(dc2.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  dc1.getPorts()[0].configureIP(new IPAddress('192.168.70.10'), mask);
  dc2.getPorts()[0].configureIP(new IPAddress('192.168.70.11'), mask);

  dc1.setCurrentUser('Administrator');
  await run(ps(dc1), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc1), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  await run(ps(dc1), 'New-ADUser -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');

  dc2.setCurrentUser('Administrator');
  await run(ps(dc2), 'Install-WindowsFeature AD-Domain-Services');
  return { dc1, dc2 };
}

describe('Install-ADDSDomainController — promoting a second DC of an existing domain', () => {
  it('syncs the existing domain content (Users OU, default groups, alice) from the source DC', async () => {
    const { dc1, dc2 } = await buildFirstDc();
    const out = await run(
      ps(dc2),
      'Install-ADDSDomainController -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.70.10 '
      + '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)',
    );
    expect(out).toContain('Success');

    const store2 = dc2.getDirectoryStore();
    expect(store2).not.toBeNull();
    expect(store2!.getUser('alice')).not.toBeNull();
    expect(store2!.getGroup('Domain Admins')).not.toBeNull();
    expect(store2!.getOrgUnit('Domain Controllers')).not.toBeNull();

  });

  it('adds its own computer account under Domain Controllers, visible via Get-ADDomainController', async () => {
    const { dc1, dc2 } = await buildFirstDc();
    await run(
      ps(dc2),
      'Install-ADDSDomainController -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.70.10 '
      + '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)',
    );

    const out = await run(ps(dc2), 'Get-ADDomainController');
    expect(out).toContain('DC2');
  });

  it('fails with bad credentials and does not create a DirectoryStore', async () => {
    const { dc2 } = await buildFirstDc();
    const out = await run(
      ps(dc2),
      'Install-ADDSDomainController -DomainName lab.local -Credential "Administrator:wrongpassword" -Server 192.168.70.10 '
      + '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)',
    );
    expect(out).toMatch(/Logon failure/);
    expect(dc2.getDirectoryStore()).toBeNull();
  });

  it('fails when the source DC address is unreachable', async () => {
    const { dc2 } = await buildFirstDc();
    const out = await run(
      ps(dc2),
      'Install-ADDSDomainController -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.70.99 '
      + '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)',
    );
    expect(out).toMatch(/could not be contacted/);
    expect(dc2.getDirectoryStore()).toBeNull();
  });

  it('refuses promotion when this server is already a domain controller', async () => {
    const { dc1 } = await buildFirstDc();
    const out = await run(
      ps(dc1),
      'Install-ADDSDomainController -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.70.10 '
      + '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)',
    );
    expect(out).toMatch(/already configured as a domain controller/);
  });
});
