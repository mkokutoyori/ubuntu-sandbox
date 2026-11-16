/**
 * Probe: the Task Scheduler Operational log follows the provider's manifest.
 *
 * Reference (rule 8): the event manifest of Microsoft-Windows-TaskScheduler (nasbench/EVTX-ETW-Resources, ETWProvidersCSVs/Internal, dumped from Windows 11
 * 24H2): 100 "Task Scheduler started {InstanceId} instance of the {TaskName} task for user {UserContext}.", 102 finished, 106 registered, 107 launched
 * due to a time trigger condition, 110 launched for user, 111 terminated, 129 launch task ... with process ID, 140 updated, 141 deleted, 142 disabled,
 * 200 action launched, 201 action completed (version 2, with the return code); the manifest quotes with single quotes, the Event Viewer prints double ones,
 * which the engine already wrote. UserContext is DOMAIN\user, here MACHINE\user. Event 4702 (learn.microsoft.com auditing reference) is the Security
 * counterpart of an update. A manual run is 110, 100, 129, 200, 201, 102 sharing one instance GUID.
 *
 * Measured before the change: 106 and 141 carried one space and the bare user name; 102 had neither the instance, the user nor "of the ... task"; 200
 * and 201 carried no instance GUID; 100, 107, 110, 129, 140, 142 and 111 were never written; `schtasks /end` answered SUCCESS for a task that was not
 * running; Stop-ScheduledTask wrote nothing; 4702 did not exist.
 *
 * Discrimination (git stash push -- src/network src/powershell): 12 of 13 cases fall on the base. Only the WITNESS that 106 is still written passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

let pc: WindowsPC;
let ps: (line: string) => Promise<string>;
let cmd: (line: string) => Promise<string>;

const log = (id: number): Promise<string> =>
  ps(`Get-WinEvent -FilterHashtable @{LogName="Microsoft-Windows-TaskScheduler/Operational"; Id=${id}} -ErrorAction SilentlyContinue | ForEach-Object { $_.Message }`);
const count = async (id: number): Promise<number> => Number((await ps(`(Get-WinEvent -FilterHashtable @{LogName="Microsoft-Windows-TaskScheduler/Operational"; Id=${id}} -ErrorAction SilentlyContinue | Measure-Object).Count`)).trim());

beforeEach(async () => {
  pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  ps = async (line) => (await shell.processLine(line)).output.join('\n');
  cmd = (line) => pc.executeCommand(line);
  await cmd('auditpol /set /subcategory:"Other Object Access Events" /success:enable');
});

describe('registration, update and deletion', () => {
  it('WITNESS: registering a task writes 106', async () => {
    await cmd('schtasks /create /tn T1 /tr calc.exe /sc daily /st 10:00');
    expect(await count(106)).toBe(1);
  });

  it('106 has the manifest wording: machine\\user, two spaces', async () => {
    await cmd('schtasks /create /tn T1 /tr calc.exe /sc daily /st 10:00');
    expect((await log(106)).trim()).toBe('User "PC1\\Administrator"  registered Task Scheduler task "\\T1"');
  });

  it('changing the action writes 140 and the Security 4702', async () => {
    await cmd('schtasks /create /tn T2 /tr calc.exe /sc daily /st 10:00');
    await cmd('schtasks /change /tn T2 /tr notepad.exe');
    expect((await log(140)).trim()).toBe('User "PC1\\Administrator"  updated Task Scheduler task "\\T2"');
    expect(await ps('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4702})[0].Message')).toContain('A scheduled task was updated.');
  });

  it('disabling writes 142 and enabling writes 140', async () => {
    await cmd('schtasks /create /tn T3 /tr calc.exe /sc daily /st 10:00');
    await cmd('schtasks /change /tn T3 /disable');
    expect((await log(142)).trim()).toBe('User "PC1\\Administrator"  disabled Task Scheduler task "\\T3"');
    await cmd('schtasks /change /tn T3 /enable');
    expect(await count(140)).toBe(1);
  });

  it('Disable-ScheduledTask writes the same 142', async () => {
    await cmd('schtasks /create /tn T4 /tr calc.exe /sc daily /st 10:00');
    await ps('Disable-ScheduledTask -TaskName T4 | Out-Null');
    expect(await count(142)).toBe(1);
  });

  it('141 has the manifest wording', async () => {
    await cmd('schtasks /create /tn T5 /tr calc.exe /sc daily /st 10:00');
    await cmd('schtasks /delete /tn T5 /f');
    expect((await log(141)).trim()).toBe('User "PC1\\Administrator"  deleted Task Scheduler task "\\T5"');
  });
});

describe('a manual run', () => {
  const GUID = /\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}/;

  it('writes 110, 100, 129, 200, 201 and 102 in that order', async () => {
    await cmd('schtasks /create /tn T6 /tr calc.exe /sc daily /st 10:00');
    await cmd('schtasks /run /tn T6');
    const ids = (await ps('Get-WinEvent -FilterHashtable @{LogName="Microsoft-Windows-TaskScheduler/Operational"} | Sort-Object RecordId | ForEach-Object { $_.Id }'))
      .split('\n').map((l) => l.trim()).filter(Boolean).filter((id) => id !== '106');
    expect(ids).toEqual(['110', '100', '129', '200', '201', '102']);
  });

  it('shares one instance GUID across 110, 100, 200, 201 and 102', async () => {
    await cmd('schtasks /create /tn T7 /tr calc.exe /sc daily /st 10:00');
    await cmd('schtasks /run /tn T7');
    const all = await ps('Get-WinEvent -FilterHashtable @{LogName="Microsoft-Windows-TaskScheduler/Operational"} | ForEach-Object { $_.Message }');
    const guids = new Set(all.match(new RegExp(GUID.source, 'g')) ?? []);
    expect(guids.size).toBe(1);
  });

  it('201 carries the return code and has version 2; 100 is "Task Started"', async () => {
    await cmd('schtasks /create /tn T8 /tr calc.exe /sc daily /st 10:00');
    await cmd('schtasks /run /tn T8');
    expect((await log(201)).trim()).toMatch(/with return code 0\.$/);
    expect((await ps('(Get-WinEvent -FilterHashtable @{LogName="Microsoft-Windows-TaskScheduler/Operational"; Id=201})[0].Version')).trim()).toBe('2');
    expect((await ps('(Get-WinEvent -FilterHashtable @{LogName="Microsoft-Windows-TaskScheduler/Operational"; Id=100})[0].TaskDisplayName')).trim()).toBe('Task Started');
  });

  it('a run caused by the clock writes 107 instead of 110', async () => {
    await cmd('schtasks /create /tn T9 /tr calc.exe /sc minute /mo 1');
    pc.advanceTime(150_000);
    expect(await count(107)).toBeGreaterThan(0);
    expect(await count(110)).toBe(0);
  });
});

describe('ending an instance', () => {
  it('/end terminates the running instance and writes 111', async () => {
    await cmd('schtasks /create /tn T10 /tr calc.exe /sc daily /st 10:00');
    await cmd('schtasks /run /tn T10');
    expect(await cmd('schtasks /end /tn T10')).toContain('SUCCESS');
    expect((await log(111)).trim()).toMatch(/^Task Scheduler terminated "\{[0-9A-F-]+\}"  instance of the "\\T10"  task\.$/);
  });

  it('/end refuses when no instance runs, and the same goes for a task that does not exist', async () => {
    await cmd('schtasks /create /tn T11 /tr calc.exe /sc daily /st 10:00');
    expect(await cmd('schtasks /end /tn T11')).toContain('ERROR: There is no running instance of the task.');
    expect(await cmd('schtasks /end /tn Nobody')).toContain('ERROR');
    expect(await count(111)).toBe(0);
  });

  it('Stop-ScheduledTask ends the instance through the same path', async () => {
    await cmd('schtasks /create /tn T12 /tr calc.exe /sc daily /st 10:00');
    await cmd('schtasks /run /tn T12');
    await ps('Stop-ScheduledTask -TaskName T12');
    expect(await count(111)).toBe(1);
    await ps('Stop-ScheduledTask -TaskName T12');
    expect(await count(111)).toBe(1);
  });
});
