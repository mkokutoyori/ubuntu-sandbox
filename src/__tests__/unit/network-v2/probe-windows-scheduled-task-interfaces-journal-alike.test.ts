/**
 * Probe: `schtasks` and the `*-ScheduledTask` cmdlets, two interfaces of one task store, leave the same trail.
 *
 * Measured before the change, as Administrator, with "Audit Other Object Access Events" enabled:
 *  - `schtasks /create` wrote 106 in Microsoft-Windows-TaskScheduler/Operational and no 4698 in Security; `Register-ScheduledTask` wrote 4698
 *    and no 106 (the reverse); `schtasks /delete` wrote 141, `Unregister-ScheduledTask` wrote nothing;
 *  - disabling, enabling and deleting a task wrote nothing in Security from either interface, where the reference defines 4701, 4700 and 4699.
 * Rule 3: a machine has one task store and one event log; the same fact reached through two interfaces must not be journalled by one and
 * ignored by the other. Both interfaces now call WindowsPC.announceTaskRegistered / announceTaskDeleted / announceTaskStateChange.
 *
 * Reference (rule 8): Microsoft's security auditing reference, events 4698, 4699, 4700 and 4701 (learn.microsoft.com, previous-versions
 * windows-10 security/threat-protection/auditing/event-469x): subcategory Audit Other Object Access Events, EventData SubjectUser* plus
 * TaskName (written `\Name`) and TaskContent. TaskContent is the task's XML definition (see probe-windows-task-events-carry-the-xml-definition).
 * 4698 now writes its TaskName with the leading backslash the reference shows.
 *
 * Discrimination (git stash push -- src/network src/powershell, against the commit that first aligned 106, 141 and 4698): 7 of 13 cases fall:
 * schtasks writing 4698, Register-ScheduledTask's 4698 in the reference form (the backslash), 4699 from both interfaces, 4700 and 4701 from
 * both, and the descriptor. Six pass either way: the cases that commit closed (106 from both interfaces, 141 from both) and the two guards
 * (a toggle to the state the task already has, and the subcategory off), kept as non-regression. Before that commit the same probe, in its
 * first six cases, had 3 of 6 failing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

let ps: (line: string) => Promise<string>;
let cmd: (line: string) => Promise<string>;

const SCHEDULER = 'Microsoft-Windows-TaskScheduler/Operational';
const ids = (log: string, id: number): string => `(Get-WinEvent -FilterHashtable @{LogName="${log}"; Id=${id}} -ErrorAction SilentlyContinue | Measure-Object).Count`;

beforeEach(async () => {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  ps = async (line) => (await shell.processLine(line)).output.join('\n');
  cmd = (line) => pc.executeCommand(line);
  await cmd('auditpol /set /subcategory:"Other Object Access Events" /success:enable');
});

describe('one task store, one trail', () => {
  it('WITNESS: schtasks /create writes 106 in the Task Scheduler log', async () => {
    await cmd('schtasks /create /tn T1 /tr calc.exe /sc daily /st 10:00');
    expect((await ps(ids(SCHEDULER, 106))).trim()).toBe('1');
  });

  it('schtasks /create also writes 4698 in the Security log', async () => {
    await cmd('schtasks /create /tn T2 /tr calc.exe /sc daily /st 10:00');
    expect(await ps('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4698})[0].Message')).toMatch(/Task Name:\s+\\T2/);
  });

  it('Register-ScheduledTask writes 106 as schtasks does', async () => {
    await ps('Register-ScheduledTask -TaskName T3 -Action (New-ScheduledTaskAction -Execute calc.exe) -Trigger (New-ScheduledTaskTrigger -Daily -At 3am)');
    expect(await ps('(Get-WinEvent -FilterHashtable @{LogName="Microsoft-Windows-TaskScheduler/Operational"; Id=106})[0].Message')).toBe('User "Administrator" registered Task Scheduler task "\\T3"');
  });

  it('Register-ScheduledTask still writes 4698', async () => {
    await ps('Register-ScheduledTask -TaskName T4 -Action (New-ScheduledTaskAction -Execute calc.exe) -Trigger (New-ScheduledTaskTrigger -Daily -At 3am)');
    expect(await ps('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4698})[0].Message')).toMatch(/Task Name:\s+\\T4/);
  });

  it('schtasks /delete writes 141', async () => {
    await cmd('schtasks /create /tn T5 /tr calc.exe /sc daily /st 10:00');
    await cmd('schtasks /delete /tn T5 /f');
    expect(await ps('(Get-WinEvent -FilterHashtable @{LogName="Microsoft-Windows-TaskScheduler/Operational"; Id=141})[0].Message')).toBe('User "Administrator" deleted Task Scheduler task "\\T5"');
  });

  it('Unregister-ScheduledTask writes 141 as schtasks /delete does', async () => {
    await ps('Register-ScheduledTask -TaskName T6 -Action (New-ScheduledTaskAction -Execute calc.exe) -Trigger (New-ScheduledTaskTrigger -Daily -At 3am)');
    await ps('Unregister-ScheduledTask -TaskName T6 -Confirm:$false');
    expect(await ps('(Get-WinEvent -FilterHashtable @{LogName="Microsoft-Windows-TaskScheduler/Operational"; Id=141})[0].Message')).toBe('User "Administrator" deleted Task Scheduler task "\\T6"');
  });

  it('schtasks /delete writes 4699 with the task name', async () => {
    await cmd('schtasks /create /tn T7 /tr calc.exe /sc daily /st 10:00');
    await cmd('schtasks /delete /tn T7 /f');
    const xml = await ps('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4699})[0].ToXml()');
    expect(xml).toContain("<Data Name='TaskName'>\\T7</Data>");
    expect(xml).toContain("<Data Name='SubjectUserName'>Administrator</Data>");
  });

  it('Unregister-ScheduledTask writes 4699 as schtasks /delete does', async () => {
    await ps('Register-ScheduledTask -TaskName T8 -Action (New-ScheduledTaskAction -Execute calc.exe) -Trigger (New-ScheduledTaskTrigger -Daily -At 3am)');
    await ps('Unregister-ScheduledTask -TaskName T8 -Confirm:$false');
    expect(await ps('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4699})[0].Message')).toMatch(/Task Name:\s+\\T8/);
  });

  it('schtasks /change /disable writes 4701 and /enable writes 4700', async () => {
    await cmd('schtasks /create /tn T9 /tr calc.exe /sc daily /st 10:00');
    await cmd('schtasks /change /tn T9 /disable');
    expect(await ps('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4701})[0].Message')).toContain('A scheduled task was disabled.');
    await cmd('schtasks /change /tn T9 /enable');
    expect(await ps('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4700})[0].Message')).toContain('A scheduled task was enabled.');
  });

  it('Disable-ScheduledTask writes 4701 and Enable-ScheduledTask writes 4700', async () => {
    await ps('Register-ScheduledTask -TaskName T10 -Action (New-ScheduledTaskAction -Execute calc.exe) -Trigger (New-ScheduledTaskTrigger -Daily -At 3am)');
    await ps('Disable-ScheduledTask -TaskName T10');
    expect(await ps('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4701})[0].Message')).toMatch(/Task Name:\s+\\T10/);
    await ps('Enable-ScheduledTask -TaskName T10');
    expect(await ps('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4700})[0].Message')).toMatch(/Task Name:\s+\\T10/);
  });

  it('the descriptor of the four entries is the reference one: subcategory Other Object Access, audit success', async () => {
    await cmd('schtasks /create /tn T11 /tr calc.exe /sc daily /st 10:00');
    await cmd('schtasks /change /tn T11 /disable');
    const xml = await ps('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4701})[0].ToXml()');
    expect(xml).toContain('<Keywords>0x8020000000000000</Keywords>');
  });

  it('a change to the state the task already has writes nothing', async () => {
    await cmd('schtasks /create /tn T12 /tr calc.exe /sc daily /st 10:00');
    await cmd('schtasks /change /tn T12 /enable');
    await ps('Enable-ScheduledTask -TaskName T12');
    expect(await ps('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4700} -ErrorAction SilentlyContinue | Measure-Object).Count')).toBe('0');
  });

  it('nothing reaches Security while the subcategory does not audit successes', async () => {
    await cmd('auditpol /set /subcategory:"Other Object Access Events" /success:disable');
    await cmd('schtasks /create /tn T13 /tr calc.exe /sc daily /st 10:00');
    await cmd('schtasks /change /tn T13 /disable');
    await cmd('schtasks /delete /tn T13 /f');
    expect(await ps('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4698,4699,4700,4701} -ErrorAction SilentlyContinue | Measure-Object).Count')).toBe('0');
  });
});
