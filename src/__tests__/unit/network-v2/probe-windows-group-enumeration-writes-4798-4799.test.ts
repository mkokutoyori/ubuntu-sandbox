/**
 * Probe: enumerating local group memberships writes 4798 and 4799.
 *
 * Reference (rule 8): Microsoft's security auditing reference, events 4798 and 4799 (learn.microsoft.com, previous-versions windows-10
 * security/threat-protection/auditing/event-4798 and event-4799): 4798 is written when a process enumerates a user's security-enabled local groups
 * (Task 13824, User Account Management), 4799 when it enumerates the members of a security-enabled local group (Task 13826, Security Group
 * Management); both Version 0, Keywords 0x8020000000000000, fields TargetUserName/TargetDomainName/TargetSid, the Subject* fields,
 * CallerProcessId and CallerProcessName. Both subcategories audit success by default.
 *
 * Measured before the change: `net user alice`, `net localgroup Administrators` and `Get-LocalGroupMember -Group Administrators` printed the
 * memberships and the Security log held no 4798 and no 4799, so the reconnaissance a SOC watches for left no trace. The cmd and PowerShell
 * interfaces read one store and now announce through one method (WindowsPC.announceGroupEnumeration). The caller of `net` is net1.exe (it has no
 * process of its own in the simulator, so its Process ID is 0x0); the caller of the cmdlet is pwsh.exe with its real Process ID.
 *
 * Discrimination (git stash push -- src/network src/powershell): 6 of 8 cases fall on the base. Two pass either way: the WITNESS that the listing
 * itself still works, and the refusal for a group that does not exist (the command fails, nothing was enumerated).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

let pc: WindowsPC;
let ps: (line: string) => Promise<string>;

const latest = (id: number): Promise<string> =>
  ps(`(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=${id}} -ErrorAction SilentlyContinue)[0].Message`);
const count = (id: number): Promise<string> =>
  ps(`(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=${id}} -ErrorAction SilentlyContinue | Measure-Object).Count`);

beforeEach(async () => {
  EquipmentRegistry.getInstance().clear();
  pc = new WindowsPC('windows-pc', 'PC-A', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  ps = async (line) => (await shell.processLine(line)).output.join('\n').trim();
  await ps('New-LocalUser -Name alice -Password (ConvertTo-SecureString "Passw0rd!" -AsPlainText -Force) | Out-Null');
  await ps('Add-LocalGroupMember -Group Administrators -Member alice');
});

describe('4798 — a user\'s local groups are enumerated', () => {
  it('WITNESS: net user still lists the memberships', async () => {
    expect(await pc.executeCommand('net user alice')).toContain('*Administrators');
  });

  it('is written by net user <name>, naming the user and the caller', async () => {
    await pc.executeCommand('net user alice');
    const out = await latest(4798);
    expect(out).toContain('A user\'s local group membership was enumerated.');
    expect(out).toMatch(/Account Name:\s+alice/);
    expect(out).toMatch(/Process Name:\s+C:\\Windows\\System32\\net1\.exe/);
  });

  it('names the subject that ran the command', async () => {
    await pc.executeCommand('net user alice');
    expect(await latest(4798)).toMatch(/Subject:[\s\S]*Account Name:\s+Administrator/);
  });

  it('is governed by User Account Management, Task 13824', async () => {
    await pc.executeCommand('net user alice');
    expect(await ps(`(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4798})[0].TaskDisplayName`)).toBe('User Account Management');
  });
});

describe('4799 — a local group\'s members are enumerated', () => {
  it('is written by net localgroup <group>, naming the group', async () => {
    await pc.executeCommand('net localgroup Administrators');
    const out = await latest(4799);
    expect(out).toContain('A security-enabled local group membership was enumerated.');
    expect(out).toMatch(/Group Name:\s+Administrators/);
  });

  it('is written by Get-LocalGroupMember with the pwsh.exe caller', async () => {
    await ps('Get-LocalGroupMember -Group Administrators | Out-Null');
    expect(await latest(4799)).toMatch(/Process Name:\s+C:\\Program Files\\PowerShell\\7\\pwsh\.exe/);
  });

  it('is governed by Security Group Management, Task 13826', async () => {
    await pc.executeCommand('net localgroup Administrators');
    expect(await ps(`(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4799})[0].TaskDisplayName`)).toBe('Security Group Management');
  });

  it('is not written for a group that does not exist', async () => {
    await pc.executeCommand('net localgroup NoSuchGroup');
    expect(await count(4799)).toBe('0');
  });
});
