/*
 * Probe: Rename-LocalUser renamed the account and wrote nothing (4781 was only declared in the event descriptor). Source
 * (rule 8): Microsoft Learn, "4781(S): The name of an account was changed." (previous-versions windows-10 auditing event-4781,
 * read in this session): subcategory User Account Management, version 0, generated on member servers and workstations for user
 * accounts; EventData OldTargetUserName, NewTargetUserName, TargetDomainName, TargetSid, SubjectUserSid / SubjectUserName /
 * SubjectDomainName / SubjectLogonId, PrivilegeList. The target SID is the account's own and does not change with the name.
 *
 * Discriminated with git stash on src: 4 of 6 fall before the fix; two pass either way and are named: the witness (the account
 * is renamed) and "writes nothing when the sub-category is not audited" (nothing was written for anything).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

async function lab() {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.powerOn();
  pc.setCurrentUser('Administrator');
  const sh = PowerShellSubShell.create(pc).subShell;
  const run = async (line: string) => (await sh.processLine(line)).output.join('\n').trim();
  await run('auditpol /set /subcategory:"User Account Management" /success:enable');
  await run('New-LocalUser -Name erin -Password (ConvertTo-SecureString "Passw0rd!" -AsPlainText -Force) | Out-Null');
  return { pc, run };
}

const xmlOf = (pc: WindowsPC, id: number) =>
  pc.executeCmdCommand(`wevtutil qe Security /q:"*[System[EventID=${id}]]" /rd:true /f:xml`).then(String);
const data = (xml: string, name: string) => new RegExp(`<Data Name='${name}'>([^<]*)</Data>`).exec(xml)?.[1] ?? '';

describe('Rename-LocalUser writes 4781', () => {
  it('witness: the account is renamed', async () => {
    const { run } = await lab();
    await run('Rename-LocalUser -Name erin -NewName erin2');
    expect(await run('(Get-LocalUser -Name erin2).Name')).toBe('erin2');
  });

  it('writes one 4781 naming the old and the new account name', async () => {
    const { pc, run } = await lab();
    await run('Rename-LocalUser -Name erin -NewName erin2');
    const xml = await xmlOf(pc, 4781);
    expect(data(xml, 'OldTargetUserName')).toBe('erin');
    expect(data(xml, 'NewTargetUserName')).toBe('erin2');
  });

  it('carries the subject that renamed it', async () => {
    const { pc, run } = await lab();
    await run('Rename-LocalUser -Name erin -NewName erin2');
    expect(data(await xmlOf(pc, 4781), 'SubjectUserName')).toBe('Administrator');
  });

  it('the target SID is the account SID before the rename', async () => {
    const { pc, run } = await lab();
    const before = await run('(Get-LocalUser -Name erin).SID.ToString()');
    await run('Rename-LocalUser -Name erin -NewName erin2');
    expect(data(await xmlOf(pc, 4781), 'TargetSid')).toBe(before);
  });

  it('renders the message with the Old and New Account Name lines', async () => {
    const { run } = await lab();
    await run('Rename-LocalUser -Name erin -NewName erin2');
    const message = await run('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4781}).Message');
    expect(message).toContain('The name of an account was changed:');
    expect(message).toMatch(/Old Account Name:\s+erin/);
    expect(message).toMatch(/New Account Name:\s+erin2/);
  });

  it('writes nothing when the sub-category is not audited', async () => {
    const { pc, run } = await lab();
    await run('auditpol /set /subcategory:"User Account Management" /success:disable');
    await run('Rename-LocalUser -Name erin -NewName erin2');
    expect(await xmlOf(pc, 4781)).not.toContain('OldTargetUserName');
  });
});
