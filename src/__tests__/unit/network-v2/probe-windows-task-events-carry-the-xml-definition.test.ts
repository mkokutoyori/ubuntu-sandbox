/**
 * Probe: the TaskContent of 4698, 4699, 4700 and 4701 is the task's XML definition.
 *
 * Reference (rule 8): Microsoft's security auditing reference, event 4698 (learn.microsoft.com, previous-versions windows-10
 * security/threat-protection/auditing/event-4698): TaskContent is the Task Scheduler XML of the task, <Task version="1.2" xmlns="...mit/task">
 * with RegistrationInfo (Date, Author), Triggers, Principals (RunLevel, UserId, LogonType), Settings and Actions/Exec/Command. The trigger shapes come
 * from the Task Scheduler schema examples (learn.microsoft.com/windows/win32/taskschd): TimeTrigger, CalendarTrigger with ScheduleByDay
 * (DaysInterval), ScheduleByWeek (WeeksInterval, DaysOfWeek), ScheduleByMonth (DaysOfMonth, Months), BootTrigger, LogonTrigger, and Repetition.
 *
 * Measured before the change: TaskContent was the bare command line (the string given to /tr), so a task registered with a daily trigger, a run-as
 * account and a settings block was indistinguishable in the log from one with none, and 4701 (disabled) carried no mark that it was disabled.
 *
 * Discrimination (git stash push -- src/network src/powershell): 10 of 12 cases fall on the base. Two pass either way: the WITNESS that the command
 * still appears in the content, and the case where a subcategory left off writes nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

let ps: (line: string) => Promise<string>;
let cmd: (line: string) => Promise<string>;

const content = (id: number): Promise<string> => ps(`(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=${id}})[0].Message`);

beforeEach(async () => {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  ps = async (line) => (await shell.processLine(line)).output.join('\n');
  cmd = (line) => pc.executeCommand(line);
  await cmd('auditpol /set /subcategory:"Other Object Access Events" /success:enable');
});

describe('4698 carries the task definition', () => {
  it('WITNESS: the command is still in the content', async () => {
    await cmd('schtasks /create /tn T1 /tr calc.exe /sc daily /st 10:00');
    expect(await content(4698)).toContain('calc.exe');
  });

  it('is a Task document in the Task Scheduler namespace', async () => {
    await cmd('schtasks /create /tn T2 /tr calc.exe /sc daily /st 10:00');
    const out = await content(4698);
    expect(out).toContain('<?xml version="1.0" encoding="UTF-16"?>');
    expect(out).toContain('<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">');
  });

  it('names the author and the account the task runs as', async () => {
    await cmd('schtasks /create /tn T3 /tr calc.exe /sc daily /st 10:00 /ru SYSTEM');
    const out = await content(4698);
    expect(out).toContain('<Author>PC1\\Administrator</Author>');
    expect(out).toContain('<UserId>SYSTEM</UserId>');
  });

  it('a daily task is a calendar trigger by day', async () => {
    await cmd('schtasks /create /tn T4 /tr calc.exe /sc daily /mo 3 /st 10:00');
    const out = await content(4698);
    expect(out).toContain('<CalendarTrigger>');
    expect(out).toContain('<DaysInterval>3</DaysInterval>');
  });

  it('a weekly task names its weekday and its week interval', async () => {
    await cmd('schtasks /create /tn T5 /tr calc.exe /sc weekly /mo 2 /d MON /st 08:00');
    const out = await content(4698);
    expect(out).toContain('<WeeksInterval>2</WeeksInterval>');
    expect(out).toContain('<Monday/>');
  });

  it('a monthly task names its day of the month', async () => {
    await cmd('schtasks /create /tn T6 /tr calc.exe /sc monthly /d 15 /st 08:00');
    const out = await content(4698);
    expect(out).toContain('<ScheduleByMonth>');
    expect(out).toContain('<Day>15</Day>');
  });

  it('a boot task is a boot trigger and a logon task a logon trigger', async () => {
    await cmd('schtasks /create /tn T7 /tr calc.exe /sc onstart');
    expect(await content(4698)).toContain('<BootTrigger>');
    await cmd('schtasks /create /tn T8 /tr calc.exe /sc onlogon');
    expect(await content(4698)).toContain('<LogonTrigger>');
  });

  it('splits the program from its arguments', async () => {
    await cmd('schtasks /create /tn T9 /tr "C:\\Tools\\run.exe -v 2" /sc daily /st 10:00');
    const out = await content(4698);
    expect(out).toContain('<Command>C:\\Tools\\run.exe</Command>');
    expect(out).toContain('<Arguments>-v 2</Arguments>');
  });

  it('Register-ScheduledTask writes the same kind of document', async () => {
    await ps('Register-ScheduledTask -TaskName T10 -Action (New-ScheduledTaskAction -Execute calc.exe) -Trigger (New-ScheduledTaskTrigger -Daily -At 3am)');
    const out = await content(4698);
    expect(out).toContain('<Task version="1.2"');
    expect(out).toContain('<Command>calc.exe</Command>');
  });
});

describe('4699, 4700 and 4701 carry it too', () => {
  it('4701 (disabled) shows Enabled false, 4700 (enabled) shows Enabled true', async () => {
    await cmd('schtasks /create /tn T11 /tr calc.exe /sc daily /st 10:00');
    await cmd('schtasks /change /tn T11 /disable');
    expect(await content(4701)).toContain('<Enabled>false</Enabled>');
    await cmd('schtasks /change /tn T11 /enable');
    expect(await content(4700)).toContain('<Enabled>true</Enabled>');
  });

  it('4699 (deleted) carries the definition of the task that was deleted', async () => {
    await cmd('schtasks /create /tn T12 /tr calc.exe /sc weekly /d FRI /st 10:00');
    await cmd('schtasks /delete /tn T12 /f');
    expect(await content(4699)).toContain('<Friday/>');
  });
});

describe('with the subcategory off', () => {
  it('nothing is written', async () => {
    await cmd('auditpol /set /subcategory:"Other Object Access Events" /success:disable');
    await cmd('schtasks /create /tn T13 /tr calc.exe /sc daily /st 10:00');
    expect((await ps('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4698} -ErrorAction SilentlyContinue | Measure-Object).Count')).trim()).toBe('0');
  });
});
