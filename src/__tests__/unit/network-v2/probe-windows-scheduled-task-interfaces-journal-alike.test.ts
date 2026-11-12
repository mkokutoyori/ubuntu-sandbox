/**
 * Probe: `schtasks` and the `*-ScheduledTask` cmdlets, two interfaces of one task store, leave the same trail.
 *
 * Measured before the change, as Administrator, with "Audit Other Object Access Events" enabled:
 *  - `schtasks /create` wrote 106 in Microsoft-Windows-TaskScheduler/Operational and no 4698 in Security;
 *  - `Register-ScheduledTask` wrote 4698 and no 106 (the reverse);
 *  - `schtasks /delete` wrote 141, `Unregister-ScheduledTask` wrote nothing.
 * Rule 3: a machine has one task store and one event log; the same fact reached through two interfaces must not be journalled by one and
 * ignored by the other. Both now call WindowsPC.announceTaskRegistered / announceTaskDeleted, which write the entries the reference
 * already had (106 and 141 in the Task Scheduler log, 4698 in Security when the subcategory audits successes).
 *
 * Discrimination (git stash push -- src/network src/powershell): 3 of 6 cases fall on the base. Three pass either way: the WITNESS (schtasks
 * /create writes 106), "schtasks /delete writes 141" and "Register-ScheduledTask still writes 4698" (non-regression of what each path already did).
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
    expect(await ps('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4698})[0].Message')).toMatch(/Task Name:\s+T2/);
  });

  it('Register-ScheduledTask writes 106 as schtasks does', async () => {
    await ps('Register-ScheduledTask -TaskName T3 -Action (New-ScheduledTaskAction -Execute calc.exe) -Trigger (New-ScheduledTaskTrigger -Daily -At 3am)');
    expect(await ps('(Get-WinEvent -FilterHashtable @{LogName="Microsoft-Windows-TaskScheduler/Operational"; Id=106})[0].Message')).toBe('User "Administrator" registered Task Scheduler task "\\T3"');
  });

  it('Register-ScheduledTask still writes 4698', async () => {
    await ps('Register-ScheduledTask -TaskName T4 -Action (New-ScheduledTaskAction -Execute calc.exe) -Trigger (New-ScheduledTaskTrigger -Daily -At 3am)');
    expect(await ps('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4698})[0].Message')).toMatch(/Task Name:\s+T4/);
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
});
