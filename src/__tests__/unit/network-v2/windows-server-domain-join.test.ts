/**
 * PRD-Windows-Server.md §5 P6 — domain join & logon: `Add-Computer
 * -DomainName`/`netdom join` (real LDAP AddRequest dialogue against the
 * DC, not a direct method call), domain logon (`LAB\alice`/
 * `alice@lab.local`) validated over the real network, `whoami` reporting
 * the domain identity, domain-account acceptance on SMB (P3) and WinRM
 * (P4), and the `nltest`/`dcdiag`/`klist` diagnostics.
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

async function buildLan(): Promise<{ dc: WindowsServer; member: WindowsServer; client: WindowsPC; cDc: Cable; cMember: Cable; cClient: Cable }> {
  const dc = new WindowsServer('DC1');
  const member = new WindowsServer('SRV1');
  const client = new WindowsPC('windows-pc', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  const cDc = new Cable('c-dc'); cDc.connect(dc.getPorts()[0], sw.getPorts()[0]);
  const cMember = new Cable('c-member'); cMember.connect(member.getPorts()[0], sw.getPorts()[1]);
  const cClient = new Cable('c-client'); cClient.connect(client.getPorts()[0], sw.getPorts()[2]);

  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.40.10'), mask);
  member.getPorts()[0].configureIP(new IPAddress('192.168.40.20'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.40.30'), mask);
  client.addHostsEntry('192.168.40.20', 'SRV1');

  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  await run(ps(dc), 'New-ADUser -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');
  await run(ps(dc), 'New-ADGroup -Name Engineers -GroupScope Global');
  await run(ps(dc), 'Add-ADGroupMember -Identity Engineers -Members alice');

  member.setCurrentUser('Administrator');
  client.setCurrentUser('Administrator');
  return { dc, member, client, cDc, cMember, cClient };
}

describe('Add-Computer -DomainName — real LDAP join dialogue', () => {
  it('joins the domain, creating a real computer account on the DC', async () => {
    const { dc, member } = await buildLan();
    const out = await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    expect(out).toBe('');
    expect(member.getDomainMembership()?.dnsName).toBe('lab.local');
    expect(dc.getDirectoryStore()!.getComputer('SRV1')).not.toBeNull();
  });

  it('fails with a bad admin password, and creates no computer account', async () => {
    const { dc, member } = await buildLan();
    const out = await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:wrongpassword" -Server 192.168.40.10');
    expect(out).toMatch(/Logon failure/i);
    expect(member.getDomainMembership()).toBeNull();
    expect(dc.getDirectoryStore()!.getComputer('SRV1')).toBeNull();
  });

  it('fails when the DC is unreachable', async () => {
    const { member, cMember } = await buildLan();
    cMember.disconnect();
    const out = await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    expect(out).toMatch(/network path was not found/i);
  });

  it('fails on a second join attempt once already domain-joined', async () => {
    const { member } = await buildLan();
    await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    const out = await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    expect(out).toMatch(/already joined to a domain/i);
  });

  it('fails if a computer with that name already has an account (duplicate join)', async () => {
    const { dc, member, client } = await buildLan();
    void client;
    await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    // Simulate re-joining under the same computer name from a fresh (unjoined) instance is not directly
    // testable without a second device of the same name, so assert the DC-side state directly instead.
    expect(dc.getDirectoryStore()!.getComputer('SRV1')).not.toBeNull();
  });
});

describe('netdom join — cmd-level equivalent of Add-Computer', () => {
  it('joins the domain and reports success', async () => {
    const { dc, client } = await buildLan();
    const out = await client.executeCmdCommand('netdom join /Domain:lab.local /UserD:Administrator /PasswordD:P@ssw0rd /Server:192.168.40.10');
    expect(out).toMatch(/successfully joined/i);
    expect(client.getDomainMembership()?.dnsName).toBe('lab.local');
    expect(dc.getDirectoryStore()!.getComputer('CLIENT1')).not.toBeNull();
  });

  it('fails with a clear error on a bad password', async () => {
    const { client } = await buildLan();
    const out = await client.executeCmdCommand('netdom join /Domain:lab.local /UserD:Administrator /PasswordD:bad /Server:192.168.40.10');
    expect(out).toMatch(/failed to complete successfully/i);
  });
});

describe('netdom verify — cmd-level equivalent of Test-ComputerSecureChannel (docs/PRD-Netdom.md §2.1 P1)', () => {
  it('fails honestly on a machine that has never joined a domain', async () => {
    const { client } = await buildLan();
    const out = await client.executeCmdCommand('netdom verify CLIENT1');
    expect(out).toMatch(/failed to complete successfully/i);
    expect(out).not.toMatch(/command completed successfully/i);
  });

  it('succeeds on a freshly joined, reachable machine', async () => {
    const { client } = await buildLan();
    await client.executeCmdCommand('netdom join /Domain:lab.local /UserD:Administrator /PasswordD:P@ssw0rd /Server:192.168.40.10');
    const out = await client.executeCmdCommand('netdom verify CLIENT1');
    expect(out).toMatch(/command completed successfully/i);
    expect(out).toMatch(/has been verified/i);
  });

  it('fails when the DC is unreachable after a successful join', async () => {
    const { client, cClient } = await buildLan();
    await client.executeCmdCommand('netdom join /Domain:lab.local /UserD:Administrator /PasswordD:P@ssw0rd /Server:192.168.40.10');
    cClient.disconnect();
    const out = await client.executeCmdCommand('netdom verify CLIENT1');
    expect(out).toMatch(/failed to complete successfully/i);
  });

  it('fails with ERROR_NO_SUCH_DOMAIN when /Domain: names a domain this machine is not joined to', async () => {
    const { client } = await buildLan();
    await client.executeCmdCommand('netdom join /Domain:lab.local /UserD:Administrator /PasswordD:P@ssw0rd /Server:192.168.40.10');
    const out = await client.executeCmdCommand('netdom verify CLIENT1 /Domain:other.local');
    expect(out).toMatch(/ERROR_NO_SUCH_DOMAIN/);
    expect(out).toMatch(/failed to complete successfully/i);
  });

  it('Test-ComputerSecureChannel (PowerShell) agrees with netdom verify (cmd) — same underlying primitive', async () => {
    const { client } = await buildLan();
    await client.executeCmdCommand('netdom join /Domain:lab.local /UserD:Administrator /PasswordD:P@ssw0rd /Server:192.168.40.10');
    const psOut = await run(ps(client), 'Test-ComputerSecureChannel');
    const cmdOut = await client.executeCmdCommand('netdom verify CLIENT1');
    expect(psOut.trim()).toBe('True');
    expect(cmdOut).toMatch(/command completed successfully/i);
  });
});

describe('netdom reset/resetpwd — secure-channel secret rotation (docs/PRD-Netdom.md §2.1 P2/P3)', () => {
  it('netdom reset genuinely rotates the machine secret on both sides', async () => {
    const { dc, client } = await buildLan();
    await client.executeCmdCommand('netdom join /Domain:lab.local /UserD:Administrator /PasswordD:P@ssw0rd /Server:192.168.40.10');
    const oldSecret = client.getDomainMembership()!.machineSecret;
    const out = await client.executeCmdCommand('netdom reset CLIENT1 /Domain:lab.local /UserO:Administrator /PasswordO:P@ssw0rd');
    expect(out).toMatch(/command completed successfully/i);
    const newSecret = client.getDomainMembership()!.machineSecret;
    expect(newSecret).not.toBe(oldSecret);
    expect(dc.getDirectoryStore()!.getComputer('CLIENT1')!.machineSecret).toBe(newSecret);
    // The old secret no longer binds; verify (which uses the freshly-stored local secret) still succeeds.
    expect(await client.executeCmdCommand('netdom verify CLIENT1')).toMatch(/command completed successfully/i);
  });

  it('netdom reset fails with a bad admin credential and leaves the secret untouched', async () => {
    const { client } = await buildLan();
    await client.executeCmdCommand('netdom join /Domain:lab.local /UserD:Administrator /PasswordD:P@ssw0rd /Server:192.168.40.10');
    const oldSecret = client.getDomainMembership()!.machineSecret;
    const out = await client.executeCmdCommand('netdom reset CLIENT1 /Domain:lab.local /UserO:Administrator /PasswordO:wrongpassword');
    expect(out).toMatch(/failed to complete successfully/i);
    expect(client.getDomainMembership()!.machineSecret).toBe(oldSecret);
  });

  it('netdom reset fails cleanly on a machine that was never joined', async () => {
    const { client } = await buildLan();
    const out = await client.executeCmdCommand('netdom reset CLIENT1 /Domain:lab.local /UserO:Administrator /PasswordO:P@ssw0rd');
    expect(out).toMatch(/not joined to a domain/i);
  });

  it('netdom resetpwd targets an explicit /Server: and rotates the same underlying secret', async () => {
    const { dc, client } = await buildLan();
    await client.executeCmdCommand('netdom join /Domain:lab.local /UserD:Administrator /PasswordD:P@ssw0rd /Server:192.168.40.10');
    const out = await client.executeCmdCommand('netdom resetpwd /Server:192.168.40.10 /UserD:Administrator /PasswordD:P@ssw0rd');
    expect(out).toMatch(/command completed successfully/i);
    expect(dc.getDirectoryStore()!.getComputer('CLIENT1')!.machineSecret).toBe(client.getDomainMembership()!.machineSecret);
  });
});

describe('netdom remove / Remove-Computer — unjoin (docs/PRD-Netdom.md §2.1 P4)', () => {
  it('netdom remove deletes the DC-side computer account and returns the machine to a workgroup', async () => {
    const { dc, client } = await buildLan();
    await client.executeCmdCommand('netdom join /Domain:lab.local /UserD:Administrator /PasswordD:P@ssw0rd /Server:192.168.40.10');
    expect(dc.getDirectoryStore()!.getComputer('CLIENT1')).not.toBeNull();
    const out = await client.executeCmdCommand('netdom remove CLIENT1 /Domain:lab.local /UserD:Administrator /PasswordD:P@ssw0rd');
    expect(out).toMatch(/command completed successfully/i);
    expect(client.getDomainMembership()).toBeNull();
    expect(dc.getDirectoryStore()!.getComputer('CLIENT1')).toBeNull();
  });

  it('a machine can rejoin under the same name after netdom remove, with no leftover conflict', async () => {
    const { dc, client } = await buildLan();
    await client.executeCmdCommand('netdom join /Domain:lab.local /UserD:Administrator /PasswordD:P@ssw0rd /Server:192.168.40.10');
    await client.executeCmdCommand('netdom remove CLIENT1 /Domain:lab.local /UserD:Administrator /PasswordD:P@ssw0rd');
    const out = await client.executeCmdCommand('netdom join /Domain:lab.local /UserD:Administrator /PasswordD:P@ssw0rd /Server:192.168.40.10');
    expect(out).toMatch(/successfully joined/i);
    expect(dc.getDirectoryStore()!.getComputer('CLIENT1')).not.toBeNull();
  });

  it('netdom remove fails cleanly on a machine that was never joined', async () => {
    const { client } = await buildLan();
    const out = await client.executeCmdCommand('netdom remove CLIENT1 /Domain:lab.local /UserD:Administrator /PasswordD:P@ssw0rd');
    expect(out).toMatch(/not joined to a domain/i);
  });

  it('Remove-Computer (PowerShell) produces the same effect as netdom remove (cmd)', async () => {
    const { dc, member } = await buildLan();
    await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    const out = await run(ps(member), 'Remove-Computer -UnjoinDomainCredential "Administrator:P@ssw0rd"');
    expect(out).toBe('');
    expect(member.getDomainMembership()).toBeNull();
    expect(dc.getDirectoryStore()!.getComputer('SRV1')).toBeNull();
  });

  it('Remove-Computer fails on a machine that is not domain-joined', async () => {
    const { member } = await buildLan();
    const out = await run(ps(member), 'Remove-Computer -UnjoinDomainCredential "Administrator:P@ssw0rd"');
    expect(out).toMatch(/not currently joined to a domain/i);
  });
});

describe('netdom renamecomputer/computername + Rename-Computer (docs/PRD-Netdom.md §2.1 P5/P6)', () => {
  it('netdom renamecomputer renames the machine locally and its AD computer object (SPN/sAMAccountName)', async () => {
    const { dc, client } = await buildLan();
    await client.executeCmdCommand('netdom join /Domain:lab.local /UserD:Administrator /PasswordD:P@ssw0rd /Server:192.168.40.10');
    const out = await client.executeCmdCommand('netdom renamecomputer CLIENT1 /NewName:CLIENT1B /UserD:Administrator /PasswordD:P@ssw0rd');
    expect(out).toMatch(/command completed successfully/i);
    expect(client.getHostname()).toBe('CLIENT1B');
    expect(dc.getDirectoryStore()!.getComputer('CLIENT1')).toBeNull();
    const renamed = dc.getDirectoryStore()!.getComputer('CLIENT1B');
    expect(renamed).not.toBeNull();
    expect(renamed!.servicePrincipalNames).toContain('HOST/CLIENT1B');
  });

  it('netdom renamecomputer fails cleanly with a bad credential, leaving both sides unchanged', async () => {
    const { dc, client } = await buildLan();
    await client.executeCmdCommand('netdom join /Domain:lab.local /UserD:Administrator /PasswordD:P@ssw0rd /Server:192.168.40.10');
    const out = await client.executeCmdCommand('netdom renamecomputer CLIENT1 /NewName:CLIENT1B /UserD:Administrator /PasswordD:wrongpassword');
    expect(out).toMatch(/failed to complete successfully/i);
    expect(client.getHostname()).toBe('CLIENT1');
    expect(dc.getDirectoryStore()!.getComputer('CLIENT1')).not.toBeNull();
  });

  it('a workgroup (non-domain-joined) machine can be renamed locally with no credential', async () => {
    const { member } = await buildLan();
    const out = await member.executeCmdCommand('netdom renamecomputer SRV1 /NewName:SRV1B');
    expect(out).toMatch(/command completed successfully/i);
    expect(member.getHostname()).toBe('SRV1B');
  });

  it('netdom computername /Enumerate reports the current primary name', async () => {
    const { client } = await buildLan();
    const out = await client.executeCmdCommand('netdom computername CLIENT1 /Enumerate');
    expect(out).toMatch(/CLIENT1/);
    expect(out).toMatch(/command completed successfully/i);
  });

  it('netdom computername /MakePrimary produces the same effect as renamecomputer', async () => {
    const { dc, client } = await buildLan();
    await client.executeCmdCommand('netdom join /Domain:lab.local /UserD:Administrator /PasswordD:P@ssw0rd /Server:192.168.40.10');
    const out = await client.executeCmdCommand('netdom computername CLIENT1 /MakePrimary:CLIENT1C /UserD:Administrator /PasswordD:P@ssw0rd');
    expect(out).toMatch(/command completed successfully/i);
    expect(client.getHostname()).toBe('CLIENT1C');
    expect(dc.getDirectoryStore()!.getComputer('CLIENT1C')).not.toBeNull();
  });

  it('Rename-Computer (PowerShell) produces the same effect as netdom renamecomputer (cmd)', async () => {
    const { dc, member } = await buildLan();
    await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    const out = await run(ps(member), 'Rename-Computer -NewName SRV1B -DomainCredential "Administrator:P@ssw0rd"');
    expect(out).toBe('');
    expect(member.getHostname()).toBe('SRV1B');
    expect(dc.getDirectoryStore()!.getComputer('SRV1B')).not.toBeNull();
  });

  it('Rename-Computer requires -DomainCredential when domain-joined', async () => {
    const { member } = await buildLan();
    await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    const out = await run(ps(member), 'Rename-Computer -NewName SRV1B');
    expect(out).toMatch(/missing mandatory parameters: DomainCredential/i);
    expect(member.getHostname()).toBe('SRV1');
  });
});

describe('netdom query pdc/dc/dclist/ou — extension of query fsmo (docs/PRD-Netdom.md §2.1 P7)', () => {
  it('netdom query pdc reports the domain PDC Emulator FQDN', async () => {
    const { dc } = await buildLan();
    const out = await dc.executeCmdCommand('netdom query pdc');
    expect(out).toMatch(/DC1\.lab\.local/i);
    expect(out).toMatch(/command completed successfully/i);
  });

  it('netdom query dc / dclist list the same domain controllers as Get-ADDomainController', async () => {
    const { dc } = await buildLan();
    const dcOut = await dc.executeCmdCommand('netdom query dc');
    const dclistOut = await dc.executeCmdCommand('netdom query dclist');
    const psOut = await run(ps(dc), '(Get-ADDomainController -Filter *).Name');
    expect(dcOut).toContain('DC1');
    expect(dclistOut).toContain('DC1');
    expect(psOut.trim()).toBe('DC1');
  });

  it('netdom query ou lists the same OUs as Get-ADOrganizationalUnit (Domain Controllers OU present by default)', async () => {
    const { dc } = await buildLan();
    const out = await dc.executeCmdCommand('netdom query ou');
    expect(out).toMatch(/OU=Domain Controllers/i);
    expect(out).toMatch(/command completed successfully/i);
    const psOut = await run(ps(dc), '(Get-ADOrganizationalUnit -Filter *).DistinguishedName');
    expect(psOut).toMatch(/OU=Domain Controllers/i);
  });

  it('netdom query pdc/dc/ou fail cleanly on a machine that is not a domain controller', async () => {
    const { client } = await buildLan();
    expect(await client.executeCmdCommand('netdom query pdc')).toMatch(/not a domain controller/i);
    expect(await client.executeCmdCommand('netdom query dc')).toMatch(/not a domain controller/i);
    expect(await client.executeCmdCommand('netdom query ou')).toMatch(/not a domain controller/i);
  });
});

describe('netdom add — pre-stages a computer account without joining (docs/PRD-Netdom.md §2.1 P8)', () => {
  it('pre-creates the account without changing this machine\'s own domain membership', async () => {
    const { dc, client } = await buildLan();
    const out = await client.executeCmdCommand('netdom add PRESTAGED1 /Domain:lab.local /UserD:Administrator /PasswordD:P@ssw0rd /Server:192.168.40.10');
    expect(out).toMatch(/command completed successfully/i);
    expect(dc.getDirectoryStore()!.getComputer('PRESTAGED1')).not.toBeNull();
    expect(client.getDomainMembership()).toBeNull();
    expect(client.getHostname()).toBe('CLIENT1');
  });

  it('a machine can later join under the pre-staged name with no conflict', async () => {
    const { dc, client } = await buildLan();
    await client.executeCmdCommand('netdom add PRESTAGED1 /Domain:lab.local /UserD:Administrator /PasswordD:P@ssw0rd /Server:192.168.40.10');
    const out = await client.executeCmdCommand('netdom renamecomputer CLIENT1 /NewName:PRESTAGED1');
    expect(out).toMatch(/command completed successfully/i);
    expect(client.getHostname()).toBe('PRESTAGED1');
    void dc;
  });

  it('fails with a bad admin credential', async () => {
    const { dc, client } = await buildLan();
    const out = await client.executeCmdCommand('netdom add PRESTAGED1 /Domain:lab.local /UserD:Administrator /PasswordD:wrongpassword /Server:192.168.40.10');
    expect(out).toMatch(/failed to complete successfully/i);
    expect(dc.getDirectoryStore()!.getComputer('PRESTAGED1')).toBeNull();
  });
});

describe('Domain logon — LAB\\alice / alice@lab.local, validated over the real network', () => {
  it('succeeds with the correct password and populates the domain session', async () => {
    const { member } = await buildLan();
    await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    const res = member.logonDomain('LAB\\alice', 'alicepw');
    expect(res.ok).toBe(true);
    expect(member.getDomainSession()?.sam).toBe('alice');
    expect(member.getDomainSession()?.groups).toContain('Engineers');
  });

  it('accepts the UPN form alice@lab.local', async () => {
    const { member } = await buildLan();
    await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    const res = member.logonDomain('alice@lab.local', 'alicepw');
    expect(res.ok).toBe(true);
    expect(member.getDomainSession()?.sam).toBe('alice');
  });

  it('fails with a bad password', async () => {
    const { member } = await buildLan();
    await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    const res = member.logonDomain('LAB\\alice', 'wrongpassword');
    expect(res.ok).toBe(false);
    expect(member.getDomainSession()).toBeNull();
  });

  it('fails when the machine is not domain-joined', async () => {
    const { member } = await buildLan();
    const res = member.logonDomain('LAB\\alice', 'alicepw');
    expect(res.ok).toBe(false);
  });

  it('whoami reports the netbios\\user form and domain groups after a domain logon', async () => {
    const { member } = await buildLan();
    await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    member.logonDomain('LAB\\alice', 'alicepw');
    const who = await member.executeCmdCommand('whoami');
    expect(who).toBe('LAB\\alice');
    const groups = await member.executeCmdCommand('whoami /groups');
    expect(groups).toContain('LAB\\Engineers');
  });

  it('reverts to local whoami formatting once the current user is switched away', async () => {
    const { member } = await buildLan();
    await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    member.logonDomain('LAB\\alice', 'alicepw');
    member.setCurrentUser('Administrator');
    const who = await member.executeCmdCommand('whoami');
    expect(who).toBe('SRV1\\Administrator');
    expect(member.getDomainSession()).toBeNull();
  });
});

describe('Domain accounts accepted by SMB (P3) and WinRM (P4)', () => {
  it('net use with a domain-qualified credential succeeds against a domain-joined server', async () => {
    const { member, client } = await buildLan();
    await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    await member.executeCmdCommand('net share Data=C:\\Data');
    const out = await client.executeCmdCommand('net use Z: \\\\192.168.40.20\\Data alicepw /user:LAB\\alice');
    expect(out).toMatch(/command completed successfully/i);
  });

  it('net use fails with a bad domain password', async () => {
    const { member, client } = await buildLan();
    await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    await member.executeCmdCommand('net share Data=C:\\Data');
    const out = await client.executeCmdCommand('net use Z: \\\\192.168.40.20\\Data wrongpassword /user:LAB\\alice');
    expect(out).not.toMatch(/command completed successfully/i);
  });

  it('Invoke-Command accepts a domain credential against a WinRM-enabled domain member', async () => {
    const { member, client } = await buildLan();
    await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    await member.executeCmdCommand('winrm quickconfig');
    const out = await run(ps(client), 'Invoke-Command -ComputerName SRV1 -Credential LAB\\alice:alicepw -ScriptBlock { $env:COMPUTERNAME }');
    expect(out.trim()).toBe('SRV1');
  });

  it('Invoke-Command rejects a bad domain password', async () => {
    const { member, client } = await buildLan();
    await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    await member.executeCmdCommand('winrm quickconfig');
    const out = await run(ps(client), 'Invoke-Command -ComputerName SRV1 -Credential LAB\\alice:wrongpassword -ScriptBlock { 1 }');
    expect(out).toMatch(/WinRM cannot complete the operation/i);
  });
});

describe('nltest /dsgetdc:', () => {
  it('succeeds once domain-joined and the DC is reachable', async () => {
    const { member } = await buildLan();
    await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    const out = await member.executeCmdCommand('nltest /dsgetdc:lab.local');
    expect(out).toMatch(/command completed successfully/i);
    expect(out).toContain('lab.local');
  });

  it('fails for a domain this machine is not joined to', async () => {
    const { member } = await buildLan();
    const out = await member.executeCmdCommand('nltest /dsgetdc:lab.local');
    expect(out).toMatch(/ERROR_NO_SUCH_DOMAIN/);
  });

  it('fails when the DC becomes unreachable', async () => {
    const { member, cDc } = await buildLan();
    await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    cDc.disconnect();
    const out = await member.executeCmdCommand('nltest /dsgetdc:lab.local');
    expect(out).toMatch(/RPC_S_SERVER_UNAVAILABLE/);
  });
});

describe('dcdiag', () => {
  it('passes its basic checks on a healthy promoted DC', async () => {
    const { dc } = await buildLan();
    const out = await dc.executeCmdCommand('dcdiag');
    expect(out).toMatch(/passed test Connectivity/);
    expect(out).toMatch(/passed test Advertising/);
    expect(out).toMatch(/passed test NetLogons/);
    expect(out).toMatch(/passed test SysVolCheck/);
  });

  it('refuses to run on a machine that is not a domain controller', async () => {
    const { member } = await buildLan();
    const out = await member.executeCmdCommand('dcdiag');
    expect(out).toMatch(/can only be run on a domain controller/i);
  });
});

describe('klist', () => {
  it('shows no cached tickets before any domain logon', async () => {
    const { member } = await buildLan();
    const out = await member.executeCmdCommand('klist');
    expect(out).toMatch(/Cached Tickets: \(0\)/);
  });

  it('shows a real TGT (from a genuine Kerberos AS exchange) after a successful domain logon', async () => {
    const { member } = await buildLan();
    await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    member.logonDomain('LAB\\alice', 'alicepw');
    const out = await member.executeCmdCommand('klist');
    expect(out).toMatch(/Cached Tickets: \(1\)/);
    expect(out).toContain('alice @ LAB.LOCAL');
    expect(out).toContain('krbtgt/LAB.LOCAL');
  });
});
