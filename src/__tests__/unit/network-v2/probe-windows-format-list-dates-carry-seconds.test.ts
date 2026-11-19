/**
 * Probe: a DateTime shown by Format-List or an ordinary Format-Table carries its seconds; only the FileSystem listing drops them.
 *
 * Reference (rule 8): a DateTime without a dedicated view is written by DateTime.ToString() in the current culture, "M/d/yyyy h:mm:ss tt" in en-US (.NET general date);
 * the FileSystem view of Get-ChildItem is the exception and shows "{0:d} {0:t}" (FileSystem.format.ps1xml), which is what the previous single shortcut copied
 * for every object. That the view source is not reachable from this session is said here: the exception rests on the documented Get-ChildItem output.
 *
 * Measured before the change: `Get-ScheduledTaskInfo ... | Format-List LastRunTime` printed "10/8/2026 3:00 AM" for a task that ran at 3:00:00, and any DateTime
 * property lost its seconds, so two events a few seconds apart looked simultaneous.
 *
 * Discrimination (git stash push -- src/network src/powershell): 3 of 4 cases fall on the base. The WITNESS that Get-ChildItem keeps its short form passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

let ps: (line: string) => Promise<string>;

beforeEach(() => {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  ps = async (line) => (await shell.processLine(line)).output.join('\n').trim();
});

describe('DateTime rendering', () => {
  it('Format-List shows the seconds', async () => {
    expect(await ps('[pscustomobject]@{When=[datetime]"2026-05-15T11:10:12"} | Format-List When')).toBe('When : 5/15/2026 11:10:12 AM');
  });

  it('an ordinary Format-Table shows the seconds', async () => {
    expect(await ps('[pscustomobject]@{When=[datetime]"2026-05-15T11:10:12"} | Format-Table When')).toContain('5/15/2026 11:10:12 AM');
  });

  it('Get-WinEvent TimeCreated shows the seconds in a list', async () => {
    await ps('eventcreate /l Application /so Probe /id 9 /t INFORMATION /d "x"');
    expect(await ps("Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName='Probe'} | Format-List TimeCreated")).toMatch(/TimeCreated : \d+\/\d+\/\d{4} \d+:\d{2}:\d{2} [AP]M/);
  });

  it('WITNESS: Get-ChildItem keeps the short form', async () => {
    expect(await ps('Get-ChildItem C:\\')).toMatch(/\d+\/\d+\/\d{4}\s+\d+:\d{2} [AP]M/);
  });
});
