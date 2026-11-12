/**
 * Probe: `Get-WinEvent` evaluates every selector it accepts (PowerShell 7.6, Microsoft.PowerShell.Commands.Diagnostics:
 * GetEventCommand.cs and GetEventResources.resx are the reference for the keys, the order and the messages).
 *
 * Measured on a WindowsPC before the change:
 *  - `-FilterHashtable` read LogName, Id, StartTime, EndTime only: `ProviderName`, `Level`, `Keywords`, `Data`, named event
 *    data and `SuppressHashFilter` were accepted and ignored, so `@{LogName='Application'; ProviderName='MonAppli'}` returned the
 *    whole log (rule 6: a criterion stored and not evaluated);
 *  - `-Oldest` returned the newest events; `-Path` answered "requires -LogName, -FilterHashtable, or -ListLog";
 *  - `-ListLog Security` and `-ListLog *PowerShell*` ignored their argument and listed every log, `-ListProvider *` listed the
 *    logs again, and an unknown log said "No events were found" instead of naming the log;
 *  - the list objects carried three properties (LogName, RecordCount, MaximumSizeInBytes) where an EventLogConfiguration has
 *    LogMode, LogType, LogIsolation, IsEnabled, LogFilePath, FileSize, ...; events printed as a property list instead of the
 *    default table grouped by ProviderName (Event_Format_ps1xml.cs).
 *
 * Discrimination (git stash push -- src/network src/powershell): 14 of 16 cases fall on the base. The two that pass either way:
 * the WITNESS (a plain `-LogName System -MaxEvents 3` still returns three records of the System log) and the `Id` selector,
 * which the base already evaluated (non-regression).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice } from '@/network';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

interface Lab { ps(line: string): Promise<string> }

function lab(): Lab {
  const device = createDevice('windows-pc', 0, 0);
  const shell = PowerShellSubShell.create(device as never).subShell;
  return { ps: async (line) => (await shell.processLine(line)).output.join('\n') };
}

let machine: Lab;
beforeEach(() => { machine = lab(); });

describe('Get-WinEvent selectors', () => {
  it('WITNESS: -LogName System -MaxEvents 3 returns three records of the System log', async () => {
    const out = await machine.ps('(Get-WinEvent -LogName System -MaxEvents 3 | Measure-Object).Count');
    expect(out.trim()).toBe('3');
  });

  it('Id selects the event id (non-regression)', async () => {
    const out = await machine.ps('Get-WinEvent -FilterHashtable @{LogName="System"; Id=7036} | ForEach-Object { $_.Id } | Select-Object -Unique');
    expect(out.trim()).toBe('7036');
  });

  it('ProviderName keeps only that provider', async () => {
    await machine.ps('New-EventLog -LogName Application -Source MonAppli');
    await machine.ps('Write-EventLog -LogName Application -Source MonAppli -EventId 1001 -EntryType Warning -Message "sauvegarde incomplete"');
    const out = await machine.ps('Get-WinEvent -FilterHashtable @{LogName="Application"; ProviderName="MonAppli"} | ForEach-Object { $_.ProviderName }');
    expect(out.trim()).toBe('MonAppli');
  });

  it('ProviderName alone searches every log the provider writes to', async () => {
    const out = await machine.ps('Get-WinEvent -FilterHashtable @{ProviderName="Tcpip"} | ForEach-Object { $_.LogName } | Select-Object -Unique');
    expect(out.trim()).toBe('System');
  });

  it('Level keeps only the listed levels', async () => {
    const out = await machine.ps('Get-WinEvent -FilterHashtable @{LogName="System"; Level=2} | ForEach-Object { $_.LevelDisplayName } | Select-Object -Unique');
    expect(out.trim()).toBe('Error');
  });

  it('Keywords selects audit failures and audit successes apart', async () => {
    const failures = await machine.ps('Get-WinEvent -FilterHashtable @{LogName="Security"; Keywords=4503599627370496} | ForEach-Object { $_.Id } | Select-Object -Unique');
    const successes = await machine.ps('Get-WinEvent -FilterHashtable @{LogName="Security"; Keywords=9007199254740992} | ForEach-Object { $_.Id } | Select-Object -Unique');
    expect(failures.trim().split(/\s+/)).toContain('4625');
    expect(successes.trim().split(/\s+/)).not.toContain('4625');
  });

  it('SuppressHashFilter removes what it matches', async () => {
    const out = await machine.ps('Get-WinEvent -FilterHashtable @{LogName="System"; Id=5158; SuppressHashFilter=@{Id=5158}}');
    expect(out).toContain('No events were found that match the specified selection criteria.');
  });

  it('a hashtable without LogName, ProviderName or Path is refused in the words of the reference', async () => {
    const out = await machine.ps('Get-WinEvent -FilterHashtable @{Id=1}');
    expect(out).toContain('You must specify at least one Log, Provider or Path key-value pair.');
  });

  it('an invalid StartTime is refused', async () => {
    const out = await machine.ps('Get-WinEvent -FilterHashtable @{LogName="System"; StartTime="garbage"}');
    expect(out).toContain('The following value is not in a valid DateTime format: garbage.');
  });

  it('-Oldest returns the oldest record first', async () => {
    const newest = await machine.ps('(Get-WinEvent -LogName System -MaxEvents 1).RecordId');
    const oldest = await machine.ps('(Get-WinEvent -LogName System -MaxEvents 1 -Oldest).RecordId');
    expect(Number(oldest)).toBeLessThan(Number(newest));
  });

  it('-Path reads an exported log', async () => {
    await machine.ps('wevtutil epl System C:\\exported.evtx');
    const out = await machine.ps('(Get-WinEvent -Path C:\\exported.evtx | Measure-Object).Count');
    const live = await machine.ps('(Get-WinEvent -LogName System | Measure-Object).Count');
    expect(out.trim()).toBe(live.trim());
  });

  it('-ListLog filters by name and by wildcard', async () => {
    expect((await machine.ps('Get-WinEvent -ListLog Security | ForEach-Object { $_.LogName }')).trim()).toBe('Security');
    expect((await machine.ps('Get-WinEvent -ListLog *PowerShell* | ForEach-Object { $_.LogName }')).trim()).toBe('PowerShellCore/Operational');
  });

  it('-ListLog and -LogName name an unknown log', async () => {
    expect(await machine.ps('Get-WinEvent -ListLog Nope')).toContain('There is not an event log on the localhost computer that matches "Nope".');
    const out = await machine.ps('Get-WinEvent -LogName Nope');
    expect(out).toContain('There is not an event log on the localhost computer that matches "Nope".');
    expect(out).not.toContain('No events were found');
  });

  it('-ListProvider lists providers, not logs', async () => {
    const out = await machine.ps('Get-WinEvent -ListProvider Tcpip');
    expect(out).toMatch(/Name\s+: Tcpip/);
    expect(out).toMatch(/LogLinks\s+: \{System\}/);
    expect(await machine.ps('Get-WinEvent -ListProvider Nope')).toContain('There is not an event provider on the localhost computer that matches "Nope".');
  });

  it('a log listing carries the EventLogConfiguration properties and prints as the reference table', async () => {
    const properties = await machine.ps('Get-WinEvent -ListLog Security | Format-List LogName,LogType,LogIsolation,IsEnabled,LogMode,LogFilePath');
    expect(properties).toMatch(/LogType\s+: Administrative/);
    expect(properties).toMatch(/LogIsolation\s+: Custom/);
    expect(properties).toMatch(/LogFilePath\s+: %SystemRoot%\\System32\\Winevt\\Logs\\Security\.evtx/);
    const table = await machine.ps('Get-WinEvent -ListLog Security');
    expect(table).toMatch(/LogMode\s+MaximumSizeInBytes RecordCount LogName/);
  });

  it('events print as a table grouped by ProviderName, with the time to the second', async () => {
    const out = await machine.ps('Get-WinEvent -LogName System -MaxEvents 1');
    expect(out).toMatch(/^\s*ProviderName: /m);
    expect(out).toMatch(/TimeCreated\s+Id LevelDisplayName Message/);
    expect(out).toMatch(/\d+\/\d+\/\d{4} \d+:\d{2}:\d{2} (AM|PM)/);
  });
});
