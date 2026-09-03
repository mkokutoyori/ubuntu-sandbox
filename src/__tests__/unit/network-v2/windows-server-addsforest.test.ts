/**
 * PRD-Windows-Server.md §5 P5 — AD DS core: Install-ADDSForest promoting a
 * WindowsServer to a real domain controller (DirectoryStore backed by the
 * genuine LDAP DirectoryTree engine), and the New/Get/Set/Remove-ADUser,
 * New/Get-ADGroup, Add/Remove-ADGroupMember, Get-ADComputer,
 * New/Get-ADOrganizationalUnit cmdlets that operate on it. Also covers the
 * minimal SYSVOL share and `net user /domain`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
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

async function promotedServer(): Promise<WindowsServer> {
  const srv = new WindowsServer('DC1');
  srv.setCurrentUser('Administrator');
  const sh = ps(srv);
  await run(sh, 'Install-WindowsFeature AD-Domain-Services');
  await run(sh, 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  return srv;
}

describe('Install-ADDSForest', () => {
  it('is "not recognized" when the AD-Domain-Services role is not installed (the ADDSDeployment module genuinely does not exist yet, matching real Windows)', async () => {
    const srv = new WindowsServer('DC1');
    srv.setCurrentUser('Administrator');
    const out = await run(ps(srv), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "x" -AsPlainText -Force)');
    expect(out).toMatch(/not recognized/i);
    expect(srv.getDirectoryStore()).toBeNull();
  });

  it('promotes the server to a real domain controller once the role is installed', async () => {
    const srv = await promotedServer();
    expect(srv.getDirectoryStore()).not.toBeNull();
  });

  it('fails on a second promotion attempt', async () => {
    const srv = await promotedServer();
    const out = await run(ps(srv), 'Install-ADDSForest -DomainName other.local -SafeModeAdministratorPassword (ConvertTo-SecureString "x" -AsPlainText -Force)');
    expect(out).toMatch(/already configured as a domain controller/i);
  });

  it('requires an administrator', async () => {
    const srv = new WindowsServer('DC1');
    srv.setCurrentUser('Administrator');
    await run(ps(srv), 'Install-WindowsFeature AD-Domain-Services');
    srv.setCurrentUser('bob');
    const out = await run(ps(srv), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "x" -AsPlainText -Force)');
    expect(out).toMatch(/Access is denied/i);
    expect(srv.getDirectoryStore()).toBeNull();
  });

  it('creates the DC own computer account under the Domain Controllers OU', async () => {
    const srv = await promotedServer();
    const store = srv.getDirectoryStore()!;
    const dc = store.getComputer('DC1');
    expect(dc).not.toBeNull();
    expect(dc?.dn).toBe('CN=DC1,OU=Domain Controllers,DC=lab,DC=local');
  });

  it('provisions a minimal SYSVOL share', async () => {
    const srv = await promotedServer();
    const out = await run(ps(srv), 'Get-SmbShare SYSVOL');
    expect(out).toMatch(/SYSVOL/);
  });

  it('is "not recognized" on a windows-pc (no ServerManager/AD DS on a client)', async () => {
    const pc = new WindowsPC('windows-pc', 'CLIENT1');
    const out = await run(ps(pc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "x" -AsPlainText -Force)');
    expect(out).toMatch(/not recognized/i);
  });
});

describe('New/Get/Set/Remove-ADUser', () => {
  it('creates a user visible via Get-ADUser with the expected DN/UPN', async () => {
    const srv = await promotedServer();
    const sh = ps(srv);
    const muet = await run(sh, 'New-ADUser -Name bob -AccountPassword (ConvertTo-SecureString "hunter2" -AsPlainText -Force) -DisplayName "Bob Smith"');
    expect(muet.trim()).toBe('');
    const out = await run(sh, 'New-ADUser -Name bob2 -AccountPassword (ConvertTo-SecureString "hunter2" -AsPlainText -Force) -PassThru');
    expect(out).toMatch(/bob2/);
    const get = await run(sh, 'Get-ADUser -Identity bob');
    expect(get).toContain('bob@lab.local');
    expect(get).toContain('CN=bob,CN=Users,DC=lab,DC=local');
  });

  it('Get-ADUser resolves identity by full DN', async () => {
    const srv = await promotedServer();
    const sh = ps(srv);
    await run(sh, 'New-ADUser -Name bob -AccountPassword (ConvertTo-SecureString "x" -AsPlainText -Force)');
    const out = await run(sh, 'Get-ADUser -Identity "CN=bob,CN=Users,DC=lab,DC=local"');
    expect(out).toContain('bob');
  });

  it('Set-ADUser disables and re-enables the account', async () => {
    const srv = await promotedServer();
    const sh = ps(srv);
    await run(sh, 'New-ADUser -Name bob -AccountPassword (ConvertTo-SecureString "x" -AsPlainText -Force)');
    await run(sh, 'Set-ADUser -Identity bob -Enabled $false');
    expect(srv.getDirectoryStore()!.getUser('bob')?.enabled).toBe(false);
    await run(sh, 'Set-ADUser -Identity bob -Enabled $true');
    expect(srv.getDirectoryStore()!.getUser('bob')?.enabled).toBe(true);
  });

  it('Remove-ADUser deletes the account', async () => {
    const srv = await promotedServer();
    const sh = ps(srv);
    await run(sh, 'New-ADUser -Name bob -AccountPassword (ConvertTo-SecureString "x" -AsPlainText -Force)');
    await run(sh, 'Remove-ADUser -Identity bob');
    expect(srv.getDirectoryStore()!.getUser('bob')).toBeNull();
  });

  it('Get-ADUser errors on an unknown identity', async () => {
    const srv = await promotedServer();
    const out = await run(ps(srv), 'Get-ADUser -Identity ghost');
    expect(out).toMatch(/Cannot find an object with identity/i);
  });

  it('requires an administrator to create a user', async () => {
    const srv = await promotedServer();
    srv.setCurrentUser('bob');
    const out = await run(ps(srv), 'New-ADUser -Name eve -AccountPassword (ConvertTo-SecureString "x" -AsPlainText -Force)');
    expect(out).toMatch(/Access is denied/i);
  });
});

describe('New/Get-ADGroup, Add/Remove-ADGroupMember', () => {
  it('creates a group with the given scope', async () => {
    const srv = await promotedServer();
    const sh = ps(srv);
    await run(sh, 'New-ADGroup -Name Engineers -GroupScope DomainLocal');
    const out = await run(sh, 'Get-ADGroup -Identity Engineers');
    expect(out).toContain('DomainLocal');
  });

  it('Add-ADGroupMember links a user, visible on both sides', async () => {
    const srv = await promotedServer();
    const sh = ps(srv);
    await run(sh, 'New-ADUser -Name bob -AccountPassword (ConvertTo-SecureString "x" -AsPlainText -Force)');
    await run(sh, 'New-ADGroup -Name Engineers -GroupScope Global');
    await run(sh, 'Add-ADGroupMember -Identity Engineers -Members bob');
    const store = srv.getDirectoryStore()!;
    expect(store.getGroup('Engineers')?.members).toContain('bob');
    expect(store.getUser('bob')?.memberOf).toContain('Engineers');
  });

  it('Remove-ADGroupMember unlinks a user', async () => {
    const srv = await promotedServer();
    const sh = ps(srv);
    await run(sh, 'New-ADUser -Name bob -AccountPassword (ConvertTo-SecureString "x" -AsPlainText -Force)');
    await run(sh, 'New-ADGroup -Name Engineers -GroupScope Global');
    await run(sh, 'Add-ADGroupMember -Identity Engineers -Members bob');
    await run(sh, 'Remove-ADGroupMember -Identity Engineers -Members bob -Confirm:$false');
    expect(srv.getDirectoryStore()!.getGroup('Engineers')?.members).not.toContain('bob');
  });
});

describe('Get-ADComputer', () => {
  it('finds the DC own computer account', async () => {
    const srv = await promotedServer();
    const out = await run(ps(srv), 'Get-ADComputer -Identity DC1');
    expect(out).toContain('DC1');
    expect(out).toContain('OU=Domain Controllers');
  });

  it('errors for an unknown computer', async () => {
    const srv = await promotedServer();
    const out = await run(ps(srv), 'Get-ADComputer -Identity Ghost');
    expect(out).toMatch(/Cannot find an object with identity/i);
  });
});

describe('New/Get-ADOrganizationalUnit', () => {
  it('creates and retrieves an OU', async () => {
    const srv = await promotedServer();
    const sh = ps(srv);
    await run(sh, 'New-ADOrganizationalUnit -Name Sales');
    const out = await run(sh, 'Get-ADOrganizationalUnit -Identity Sales');
    expect(out).toContain('OU=Sales,DC=lab,DC=local');
  });
});

describe('net user /domain', () => {
  it('lists domain users once promoted', async () => {
    const srv = await promotedServer();
    const sh = ps(srv);
    await run(sh, 'New-ADUser -Name bob -AccountPassword (ConvertTo-SecureString "x" -AsPlainText -Force)');
    const out = await srv.executeCmdCommand('net user /domain');
    expect(out).toMatch(/bob/);
    expect(out).toMatch(/Administrator/);
  });

  it('views a specific domain user', async () => {
    const srv = await promotedServer();
    const out = await srv.executeCmdCommand('net user Administrator /domain');
    expect(out).toContain('User name                    Administrator');
    expect(out).toMatch(/Global Group memberships.*Domain Admins/);
  });

  it('fails with a real domain-contact error before promotion', async () => {
    const srv = new WindowsServer('DC1');
    const out = await srv.executeCmdCommand('net user /domain');
    expect(out).toMatch(/1355/);
  });
});
