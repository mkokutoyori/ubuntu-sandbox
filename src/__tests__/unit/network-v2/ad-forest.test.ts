/**
 * PRD-Windows-Server-Advanced.md §5 P8 — multi-domain forest: `New-ADDomain`
 * promotes a server as the first DC of a genuinely separate child domain
 * (its own `DirectoryStore`/tree, reached via real LDAP dial+bind against
 * the parent), and `Get-ADForest` reflects the resulting domain tree. The
 * schema (attributes/classes registered via `New-ADAttribute`/
 * `New-ADObjectClass`) is shared forest-wide by construction (§8 P8):
 * a class registered on the root domain is enforceable when creating an
 * object via the child domain's own tree.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { parseDN } from '@/network/devices/windows/server/ad/ldap/LdapDN';
import { resetForestRegistry } from '@/network/devices/windows/server/ad/forest/Forest';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  resetForestRegistry();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildRootDc(): Promise<{ dc1: WindowsServer; dc2: WindowsServer }> {
  const dc1 = new WindowsServer('DC1');
  const dc2 = new WindowsServer('DC2');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc1').connect(dc1.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-dc2').connect(dc2.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  dc1.getPorts()[0].configureIP(new IPAddress('192.168.90.10'), mask);
  dc2.getPorts()[0].configureIP(new IPAddress('192.168.90.11'), mask);

  dc1.setCurrentUser('Administrator');
  await run(ps(dc1), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc1), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');

  dc2.setCurrentUser('Administrator');
  await run(ps(dc2), 'Install-WindowsFeature AD-Domain-Services');
  return { dc1, dc2 };
}

const newDomainCmd =
  'New-ADDomain -NewDomainName child.lab.local -ParentDomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.90.10 '
  + '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)';

describe('New-ADDomain / Get-ADForest — multi-domain forest', () => {
  it('creates a genuinely separate child-domain DirectoryStore reachable via real LDAP', async () => {
    const { dc2 } = await buildRootDc();
    const out = await run(ps(dc2), newDomainCmd);
    expect(out).toContain('Success');

    const store2 = dc2.getDirectoryStore();
    expect(store2).not.toBeNull();
    expect(store2!.dnsName).toBe('child.lab.local');
    expect(store2!.getOrgUnit('Domain Controllers')).not.toBeNull();
    expect(store2!.getGroup('Domain Admins')).not.toBeNull();
  });

  it('Get-ADForest reflects the domain tree (root + child)', async () => {
    const { dc1, dc2 } = await buildRootDc();
    await run(ps(dc2), newDomainCmd);

    const out1 = await run(ps(dc1), 'Get-ADForest');
    expect(out1).toContain('lab.local');
    expect(out1).toContain('child.lab.local');

    const out2 = await run(ps(dc2), 'Get-ADForest');
    expect(out2).toContain('lab.local');
    expect(out2).toContain('child.lab.local');
  });

  it('a class/attribute registered on the root domain is enforceable on the child domain (shared schema)', async () => {
    const { dc1, dc2 } = await buildRootDc();
    await run(ps(dc1), 'New-ADAttribute -Name employeeID -AttributeSyntax string -SingleValued $true');
    await run(ps(dc1), 'New-ADObjectClass -Name badgeReader -Category structural -MustContain cn,employeeID');

    await run(ps(dc2), newDomainCmd);
    const store2 = dc2.getDirectoryStore()!;

    const ok = store2.getTree().addEntry(
      parseDN('CN=Lobby-Reader-1,DC=child,DC=lab,DC=local'),
      { objectClass: ['top', 'badgeReader'], cn: ['Lobby-Reader-1'], employeeID: ['E-001'] },
    );
    expect(ok.ok).toBe(true);

    const violating = store2.getTree().addEntry(
      parseDN('CN=Lobby-Reader-2,DC=child,DC=lab,DC=local'),
      { objectClass: ['top', 'badgeReader'], cn: ['Lobby-Reader-2'] },
    );
    expect(violating.ok).toBe(false);
    expect(violating.message).toMatch(/objectClassViolation/);
  });

  it('fails with bad credentials and does not create a DirectoryStore', async () => {
    const { dc2 } = await buildRootDc();
    const out = await run(
      ps(dc2),
      'New-ADDomain -NewDomainName child.lab.local -ParentDomainName lab.local -Credential "Administrator:wrongpassword" -Server 192.168.90.10 '
      + '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)',
    );
    expect(out).toMatch(/Logon failure/);
    expect(dc2.getDirectoryStore()).toBeNull();
  });

  it('fails when the parent DC address is unreachable', async () => {
    const { dc2 } = await buildRootDc();
    const out = await run(
      ps(dc2),
      'New-ADDomain -NewDomainName child.lab.local -ParentDomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.90.99 '
      + '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)',
    );
    expect(out).toMatch(/could not be contacted/);
    expect(dc2.getDirectoryStore()).toBeNull();
  });

  it('refuses when this server is already a domain controller', async () => {
    const { dc1 } = await buildRootDc();
    const out = await run(ps(dc1), newDomainCmd);
    expect(out).toMatch(/already configured as a domain controller/);
  });

  it('Get-ADForest fails cleanly on a server that is not a DC', async () => {
    const notADc = new WindowsServer('SRV1');
    notADc.setCurrentUser('Administrator');
    await run(ps(notADc), 'Install-WindowsFeature AD-Domain-Services');
    const out = await run(ps(notADc), 'Get-ADForest');
    expect(out).toMatch(/ERROR|Unable to contact/);
  });
});
