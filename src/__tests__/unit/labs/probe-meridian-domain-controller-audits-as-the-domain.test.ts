/**
 * Probe, in the Entreprise Meridian lab: the domain controller audits directory administration as the domain, once, under its audit policy.
 *
 * Reference (rule 8): Microsoft's security auditing reference, events 4720, 4728 and 4625 (learn.microsoft.com, previous-versions windows-10 security/
 * threat-protection/auditing): Account Domain is the domain NetBIOS name for a domain account and for the machine account of a domain member, the SID is
 * the account's own SID; 4720/4722/4724/4725/4726 belong to "Audit User Account Management" and the group events to "Audit Security Group Management",
 * so a subcategory left off writes nothing. 4727, 4730, 4754 and 4758 are the global and universal group created/deleted events: their ids come from the
 * audit catalog and their titles follow the "security-enabled <scope> group" wording of 4728/4729/4756 already written; the pages for these four are not
 * reachable from the session, recorded in TODO.md.
 *
 * Measured before the change, on DC1 after `New-ADUser alice` in the lab: 4720 named Account Domain WORKGROUP for the subject and the new account, gave
 * alice a SID from the machine's local counter (S-1-5-21-3623811015-... RID 1000) instead of the directory's, and was written whatever the audit policy
 * said, because the AD cmdlets built their own WindowsSecurityAudit with a default identity next to the machine's own: two writers for one log
 * (rule 2). `New-ADGroup` and `Remove-ADGroup` wrote no group event at all. A refused logon (4625) named the controller's own machine account in domain
 * WORKGROUP.
 *
 * Discrimination (git stash push -- src/network src/powershell): 8 of 9 cases fall on the base. The WITNESS (the account is created) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetExchangeOrganizations } from '@/network/devices/windows/server/exchange/ExchangeOrganization';
import { buildMeridian, type MeridianLab } from '@/labs/entrepriseMeridian/build';
import type { Equipment } from '@/network';

const MACHINE_SID_PREFIX = 'S-1-5-21-3623811015-3361044348-30300820';

let lab: MeridianLab;
let dc: Equipment;
let mail: Equipment;

const onDc = (...lines: string[]): Promise<string> => lab.bench.powershell(dc, ...lines);
const latest = (id: number): Promise<string> => onDc(`(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=${id}})[0].Message`);

beforeEach(async () => {
  resetExchangeOrganizations();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
  useNetworkStore.getState().clearAll();
  lab = await buildMeridian();
  dc = lab.devices.get('DC1')!;
  mail = lab.devices.get('MAIL-DMZ')!;
}, 120000);

describe('4720 on the domain controller', () => {
  it('WITNESS: the account is created in the directory', async () => {
    await onDc('New-ADUser -Enabled $true -Name alice -AccountPassword (ConvertTo-SecureString "Alice#2026pw" -AsPlainText -Force)');
    expect(await onDc('(Get-ADUser -Identity alice).SamAccountName')).toBe('alice');
  }, 120000);

  it('names the domain for the subject and for the new account', async () => {
    await onDc('New-ADUser -Enabled $true -Name alice -AccountPassword (ConvertTo-SecureString "Alice#2026pw" -AsPlainText -Force)');
    const out = await latest(4720);
    expect(out).toMatch(/Account Domain:\s+MERIDIAN[\s\S]*New Account:[\s\S]*Account Domain:\s+MERIDIAN/);
    expect(out).not.toContain('WORKGROUP');
  }, 120000);

  it('gives the new account the SID the directory gave it, not a machine-local one', async () => {
    await onDc('New-ADUser -Enabled $true -Name alice -AccountPassword (ConvertTo-SecureString "Alice#2026pw" -AsPlainText -Force)');
    const out = await latest(4720);
    const newAccount = /New Account:\s+Security ID:\s+(\S+)/.exec(out)?.[1] ?? '';
    expect(newAccount).toMatch(/^S-1-5-21-/);
    expect(newAccount.startsWith(MACHINE_SID_PREFIX)).toBe(false);
  }, 120000);

  it('names the domain Administrator (RID 500 of the domain) as the subject', async () => {
    await onDc('New-ADUser -Enabled $true -Name alice -AccountPassword (ConvertTo-SecureString "Alice#2026pw" -AsPlainText -Force)');
    const subject = /Subject:\s+Security ID:\s+(\S+)/.exec(await latest(4720))?.[1] ?? '';
    expect(subject).toMatch(/-500$/);
    expect(subject.startsWith(MACHINE_SID_PREFIX)).toBe(false);
  }, 120000);

  it('is not written when User Account Management is not audited', async () => {
    await onDc('auditpol /set /subcategory:"User Account Management" /success:disable');
    await onDc('New-ADUser -Enabled $true -Name bob -AccountPassword (ConvertTo-SecureString "Bob#2026pw" -AsPlainText -Force)');
    expect((await onDc('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4720} -ErrorAction SilentlyContinue | Measure-Object).Count')).trim()).toBe('0');
  }, 120000);
});

describe('group events on the domain controller', () => {
  it('New-ADGroup -GroupScope Global writes 4727 in the domain', async () => {
    await onDc('New-ADGroup -Name Finance -GroupScope Global');
    const out = await latest(4727);
    expect(out).toContain('A security-enabled global group was created.');
    expect(out).toMatch(/Group Name:\s+Finance/);
    expect(out).toMatch(/Group Domain:\s+MERIDIAN/);
  }, 120000);

  it('Remove-ADGroup writes 4730 for a global group', async () => {
    await onDc('New-ADGroup -Name Finance -GroupScope Global', 'Remove-ADGroup -Identity Finance -Confirm:$false');
    expect(await latest(4730)).toContain('A security-enabled global group was deleted.');
  }, 120000);

  it('a universal group writes 4754', async () => {
    await onDc('New-ADGroup -Name Everyone -GroupScope Universal');
    expect(await latest(4754)).toContain('A security-enabled universal group was created.');
  }, 120000);
});

describe('a refused logon on the domain controller', () => {
  it('names the controller\'s machine account in the domain, not in WORKGROUP', async () => {
    await lab.bench.powershell(mail, 'net use Z: \\\\10.0.0.10\\SYSVOL wrong /user:MERIDIAN\\Administrator');
    const out = await latest(4625);
    expect(out).toMatch(/Subject:[\s\S]*Account Name:\s+\S+\$\s+Account Domain:\s+MERIDIAN/);
  }, 120000);
});
