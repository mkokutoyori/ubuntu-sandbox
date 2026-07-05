/**
 * PRD-Windows-Server-Advanced.md §5 P7 — extensible schema (RFC 4512):
 * `New-ADAttribute`/`New-ADObjectClass` register real `attributeSchema`/
 * `classSchema` definitions; `DirectoryTree.addEntry` now validates a new
 * object's `mustContain` against whichever of its `objectClass` values
 * are actually registered — permissive for everything else, so every
 * already-delivered class (`user`, `group`, `computer`,
 * `organizationalUnit`) keeps working unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { parseDN } from '@/network/devices/windows/server/ad/ldap/LdapDN';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildDc(): Promise<WindowsServer> {
  const dc = new WindowsServer('DC1');
  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  return dc;
}

describe('AD extensible schema — New-ADAttribute / New-ADObjectClass', () => {
  it('creates a custom attribute and object class, then a real object using that class', async () => {
    const dc = await buildDc();
    const store = dc.getDirectoryStore()!;

    let out = await run(ps(dc), 'New-ADAttribute -Name employeeID -AttributeSyntax string -SingleValued $true');
    expect(out).not.toMatch(/ERROR/);
    out = await run(ps(dc), 'New-ADObjectClass -Name badgeReader -Category structural -MustContain cn,employeeID');
    expect(out).not.toMatch(/ERROR/);

    const res = store.getTree().addEntry(
      parseDN('CN=Lobby-Reader-1,DC=lab,DC=local'),
      { objectClass: ['top', 'badgeReader'], cn: ['Lobby-Reader-1'], employeeID: ['E-001'] },
    );
    expect(res.ok).toBe(true);
  });

  it('rejects creating an object that violates mustContain for a custom class', async () => {
    const dc = await buildDc();
    const store = dc.getDirectoryStore()!;
    await run(ps(dc), 'New-ADAttribute -Name employeeID -AttributeSyntax string -SingleValued $true');
    await run(ps(dc), 'New-ADObjectClass -Name badgeReader -Category structural -MustContain cn,employeeID');

    const res = store.getTree().addEntry(
      parseDN('CN=Lobby-Reader-2,DC=lab,DC=local'),
      { objectClass: ['top', 'badgeReader'], cn: ['Lobby-Reader-2'] }, // missing employeeID
    );
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/objectClassViolation/);
  });

  it('rejects a duplicate attribute or object class name', async () => {
    const dc = await buildDc();
    await run(ps(dc), 'New-ADAttribute -Name employeeID -AttributeSyntax string -SingleValued $true');
    const out = await run(ps(dc), 'New-ADAttribute -Name employeeID -AttributeSyntax string -SingleValued $true');
    expect(out).toMatch(/already exists/);
  });

  it('leaves the already-delivered classes (user, group, computer, organizationalUnit) working unchanged', async () => {
    const dc = await buildDc();
    const out1 = await run(ps(dc), 'New-ADUser -Name bob -AccountPassword (ConvertTo-SecureString "bobpw" -AsPlainText -Force) -DisplayName "Bob"');
    expect(out1).not.toMatch(/ERROR/);
    const out2 = await run(ps(dc), 'New-ADGroup -Name Engineers -GroupScope Global');
    expect(out2).not.toMatch(/ERROR/);
    const out3 = await run(ps(dc), 'New-ADOrganizationalUnit -Name Contractors');
    expect(out3).not.toMatch(/ERROR/);

    const store = dc.getDirectoryStore()!;
    expect(store.getUser('bob')).not.toBeNull();
    expect(store.getGroup('Engineers')).not.toBeNull();
    expect(store.getOrgUnit('Contractors')).not.toBeNull();
  });
});
