/*
 * Probe: Set-ADGroup changed a group and wrote nothing. Source (rule 8): Microsoft Learn, "4735(S): A security-enabled local
 * group was changed." (previous-versions windows-10 auditing event-4735, read in this session): subcategory Audit Security Group
 * Management, version 0, task 13826; EventData TargetUserName / TargetDomainName / TargetSid, SubjectUserSid / SubjectUserName /
 * SubjectDomainName / SubjectLogonId, PrivilegeList, SamAccountName, SidHistory ("-" for an attribute that did not change; a
 * change of an attribute not listed, e.g. a Description edited in a console, still writes the event with every changed attribute
 * "-"; a change on the Managed By tab writes none). 4737 and 4755 are the same event for a global and a universal group (the
 * 4737 and 4755 pages were not reachable: the titles and the shared layout follow the 4731/4754 pairs already written and the
 * Microsoft French page that says 4737 is 4735 for a global group).
 *
 * Discriminated with git stash on src: 7 of 10 fall before both changes (4 before the group-changed events, 3 more before
 * -SamAccountName, which alone fails the last three); three pass either way and are named: the witness (New-ADGroup
 * writes 4727), "ManagedBy alone writes nothing" and "a distribution group writes nothing" (nothing was written for anything).
 * The 4735 page says a group SAM rename also writes 4781 although the 4781 page speaks of user and computer accounts only; the
 * probe follows the page of the event being written.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (d: WindowsServer, l: string) => (await ps(d).processLine(l)).output.join('\n');

async function dc() {
  const server = new WindowsServer('DC1');
  server.setCurrentUser('Administrator');
  await run(server, 'Install-WindowsFeature AD-Domain-Services');
  await run(server, 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  await run(server, 'auditpol /set /subcategory:"Security Group Management" /success:enable');
  await run(server, 'New-ADGroup -Name Eng -GroupScope Global');
  await run(server, 'New-ADGroup -Name Loc -GroupScope DomainLocal');
  await run(server, 'New-ADGroup -Name Uni -GroupScope Universal');
  await run(server, 'New-ADGroup -Name Mail -GroupScope Global -GroupCategory Distribution');
  return server;
}

const events = (server: WindowsServer, id: number) =>
  run(server, `Get-WinEvent -FilterHashtable @{LogName="Security"; Id=${id}} -ErrorAction SilentlyContinue | Format-List Id, Message`);

describe('Set-ADGroup writes the group-changed events', () => {
  it('witness: New-ADGroup writes 4727', async () => {
    expect(await events(await dc(), 4727)).toContain('A security-enabled global group was created.');
  });

  it('a global group changed writes 4737 naming the group and the subject', async () => {
    const server = await dc();
    await run(server, 'Set-ADGroup -Identity Eng -Description "engineers"');
    const out = await events(server, 4737);
    expect(out).toContain('A security-enabled global group was changed.');
    expect(out).toMatch(/Group Name:\s+Eng/);
    expect(out).toMatch(/Account Name:\s+Administrator/);
  });

  it('a domain-local group writes 4735', async () => {
    const server = await dc();
    await run(server, 'Set-ADGroup -Identity Loc -Description "x"');
    expect(await events(server, 4735)).toContain('A security-enabled local group was changed.');
  });

  it('a universal group writes 4755', async () => {
    const server = await dc();
    await run(server, 'Set-ADGroup -Identity Uni -Description "x"');
    expect(await events(server, 4755)).toContain('A security-enabled universal group was changed.');
  });

  it('an attribute that is not listed leaves every changed attribute at "-"', async () => {
    const server = await dc();
    await run(server, 'Set-ADGroup -Identity Eng -Description "x"');
    const out = await events(server, 4737);
    expect(out).toContain('Changed Attributes:');
    expect(out).toMatch(/SAM Account Name:\s+-/);
    expect(out).toMatch(/SID History:\s+-/);
  });

  it('a distribution group writes nothing: it is not security-enabled', async () => {
    const server = await dc();
    await run(server, 'Set-ADGroup -Identity Mail -Description "x"');
    expect(await events(server, 4737)).not.toContain('Group Name:');
  });

  it('ManagedBy alone writes nothing (the Managed By tab does not invoke the event)', async () => {
    const server = await dc();
    await run(server, 'Set-ADGroup -Identity Eng -ManagedBy "CN=Administrator,CN=Users,DC=lab,DC=local"');
    expect(await events(server, 4737)).not.toContain('Group Name:');
  });

  it('-SamAccountName renames the group, keeps its SID, and refuses a name another account holds', async () => {
    const server = await dc();
    const before = await run(server, '(Get-ADGroup -Identity Eng).SID.Value');
    await run(server, 'Set-ADGroup -Identity Eng -SamAccountName Eng2');
    expect(await run(server, '(Get-ADGroup -Identity Eng2).SID.Value')).toBe(before);
    expect(await run(server, 'Get-ADGroup -Identity Eng')).toContain('Cannot find an object');
    expect(await run(server, 'Set-ADGroup -Identity Eng2 -SamAccountName Loc')).toContain('already exists');
  });

  it('a renamed group writes 4737 whose SAM Account Name is the new name (4735 page: new value shown)', async () => {
    const server = await dc();
    await run(server, 'Set-ADGroup -Identity Eng -SamAccountName Eng2');
    const out = await events(server, 4737);
    expect(out).toMatch(/Group Name:\s+Eng2/);
    expect(out).toMatch(/SAM Account Name:\s+Eng2/);
  });

  it('a renamed group also writes 4781 when User Account Management is audited (4735 page)', async () => {
    const server = await dc();
    await run(server, 'auditpol /set /subcategory:"User Account Management" /success:enable');
    await run(server, 'Set-ADGroup -Identity Eng -SamAccountName Eng2');
    const xml = String(await server.executeCmdCommand('wevtutil qe Security /q:"*[System[EventID=4781]]" /rd:true /f:xml'));
    expect(xml).toContain("<Data Name='OldTargetUserName'>Eng</Data>");
    expect(xml).toContain("<Data Name='NewTargetUserName'>Eng2</Data>");
  });
});

