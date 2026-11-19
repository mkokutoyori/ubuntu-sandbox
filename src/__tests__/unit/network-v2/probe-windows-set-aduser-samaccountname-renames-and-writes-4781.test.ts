/*
 * Probe: Set-ADUser had no -SamAccountName, so a directory account could not be renamed and 4781 could not be written for it.
 * Source (rule 8): Microsoft Learn, "4781(S): The name of an account was changed." (read in this session): generated when a user
 * or computer account's sAMAccountName changes; EventData OldTargetUserName / NewTargetUserName / TargetDomainName (the domain
 * NetBIOS name on a domain controller) / TargetSid / Subject* / PrivilegeList; subcategory User Account Management. The SID
 * stays with the object. Set-ADUser -SamAccountName is the documented parameter (ActiveDirectory/Set-ADUser.md).
 *
 * Discriminated with git stash on src: 4 of 6 fall before the fix; two pass either way and are named: the witness (the
 * account exists under its first name) and "no 4781 when the name does not change" (nothing was written for anything).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

const run = async (d: WindowsServer, l: string) => (await PowerShellSubShell.create(d).subShell.processLine(l)).output.join('\n').trim();

async function dc() {
  const server = new WindowsServer('DC1');
  server.setCurrentUser('Administrator');
  await run(server, 'Install-WindowsFeature AD-Domain-Services');
  await run(server, 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  await run(server, 'auditpol /set /subcategory:"User Account Management" /success:enable');
  await run(server, 'New-ADUser -Enabled $true -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force)');
  await run(server, 'New-ADUser -Enabled $true -Name bob -AccountPassword (ConvertTo-SecureString "bobpw" -AsPlainText -Force)');
  return server;
}

const xmlOf = (server: WindowsServer) =>
  server.executeCmdCommand('wevtutil qe Security /q:"*[System[EventID=4781]]" /rd:true /f:xml').then(String);
const data = (xml: string, name: string) => new RegExp(`<Data Name='${name}'>([^<]*)</Data>`).exec(xml)?.[1] ?? '';

describe('Set-ADUser -SamAccountName renames the account and writes 4781', () => {
  it('witness: the account exists under its first name', async () => {
    expect(await run(await dc(), '(Get-ADUser -Identity alice).SamAccountName')).toBe('alice');
  });

  it('the account answers to its new name and no longer to the old one', async () => {
    const server = await dc();
    await run(server, 'Set-ADUser -Identity alice -SamAccountName alice2');
    expect(await run(server, '(Get-ADUser -Identity alice2).SamAccountName')).toBe('alice2');
    expect(await run(server, 'Get-ADUser -Identity alice')).toContain('Cannot find an object');
  });

  it('the SID stays with the object', async () => {
    const server = await dc();
    const before = await run(server, '(Get-ADUser -Identity alice).SID.Value');
    await run(server, 'Set-ADUser -Identity alice -SamAccountName alice2');
    expect(await run(server, '(Get-ADUser -Identity alice2).SID.Value')).toBe(before);
  });

  it('writes 4781 with the old and the new name and the domain NetBIOS name', async () => {
    const server = await dc();
    await run(server, 'Set-ADUser -Identity alice -SamAccountName alice2');
    const xml = await xmlOf(server);
    expect(data(xml, 'OldTargetUserName')).toBe('alice');
    expect(data(xml, 'NewTargetUserName')).toBe('alice2');
    expect(data(xml, 'TargetDomainName')).toBe('LAB');
    expect(data(xml, 'SubjectUserName')).toBe('Administrator');
  });

  it('refuses a name another account holds, and writes nothing', async () => {
    const server = await dc();
    expect(await run(server, 'Set-ADUser -Identity alice -SamAccountName bob')).toContain('already exists');
    expect(await xmlOf(server)).not.toContain('OldTargetUserName');
  });

  it('writes no 4781 when the name does not change', async () => {
    const server = await dc();
    await run(server, 'Set-ADUser -Identity alice -SamAccountName alice');
    expect(await xmlOf(server)).not.toContain('OldTargetUserName');
  });
});
