/**
 * Probe: `date <date>` and `time <time>` of cmd set the system clock, and the change is journalled as 4616.
 *
 * Reference (rule 8): official_docs/microsoft/windows-server (windows-commands, `date` and `time`): `date [/t | <month-day-year>]` sets the date,
 * month 1-12, day 1-31, year two or four digits (80-99 are 1980-1999), separators `.` `-` `/`, administrator required; `time [/t | [<HH>[:<MM>[:<SS>
 * [.<NN>]]] [am|pm]]]` sets the time, 24-hour unless am/pm is given, HH 0-24, MM and SS 0-59. Event 4616 (learn.microsoft.com, auditing reference).
 * The refusal wordings ("The system cannot accept the date entered.", "The system cannot accept the time entered.", "A required privilege is not
 * held by the client.") are those of a real cmd, not of that page: recorded in TODO.md.
 *
 * Measured before the change: `date 08-03-07` and `time 17:30` answered with the current date and time (the arguments were ignored), the clock did
 * not move and no 4616 was written, so a command that changes the machine's time left neither effect nor trace.
 *
 * Discrimination (git stash push -- src/network src/powershell): 9 of 11 cases fall on the base. Two pass either way: the WITNESS `date /t` and
 * the non-administrator case, whose assertion is that the clock does not move, true on the base because nothing moves it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

let pc: WindowsPC;
let ps: (line: string) => Promise<string>;

const dateNow = async (): Promise<string> => (await pc.executeCommand('date /t')).trim();
const timeNow = async (): Promise<string> => (await pc.executeCommand('time /t')).trim();

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  pc = new WindowsPC('windows-pc', 'PC-A', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  ps = async (line) => (await shell.processLine(line)).output.join('\n').trim();
});

describe('date', () => {
  it('WITNESS: date /t prints the current date', async () => {
    expect(await dateNow()).toMatch(/^\w{3} \d{2}\/\d{2}\/\d{4}$/);
  });

  it('sets the date with hyphens and a two-digit year', async () => {
    await pc.executeCommand('date 08-03-07');
    expect(await dateNow()).toBe('Fri 08/03/2007');
  });

  it('accepts slashes, periods and a four-digit year', async () => {
    await pc.executeCommand('date 8/4/2007');
    expect(await dateNow()).toBe('Sat 08/04/2007');
    await pc.executeCommand('date 08.05.2007');
    expect(await dateNow()).toBe('Sun 08/05/2007');
  });

  it('reads 80 to 99 as 1980 to 1999', async () => {
    await pc.executeCommand('date 1-2-85');
    expect(await dateNow()).toBe('Wed 01/02/1985');
  });

  it('keeps the time of day', async () => {
    await pc.executeCommand('time 10:15:00');
    await pc.executeCommand('date 08-03-07');
    expect(await timeNow()).toBe('10:15 AM');
  });

  it('refuses a date that does not exist and leaves the clock alone', async () => {
    await pc.executeCommand('date 08-03-07');
    expect(await pc.executeCommand('date 02-30-2020')).toBe('The system cannot accept the date entered.');
    expect(await dateNow()).toBe('Fri 08/03/2007');
  });
});

describe('time', () => {
  it('sets a 24-hour time', async () => {
    await pc.executeCommand('time 17:30:00');
    expect(await timeNow()).toBe('5:30 PM');
  });

  it('sets a 12-hour time with am or pm', async () => {
    await pc.executeCommand('time 5:30 pm');
    expect(await timeNow()).toBe('5:30 PM');
    await pc.executeCommand('time 5:30 am');
    expect(await timeNow()).toBe('5:30 AM');
  });

  it('refuses an hour out of range', async () => {
    expect(await pc.executeCommand('time 25:00')).toBe('The system cannot accept the time entered.');
  });
});

describe('the change is journalled', () => {
  it('writes 4616 naming cmd.exe as the process', async () => {
    await pc.executeCommand('auditpol /set /subcategory:"Security State Change" /success:enable');
    await pc.executeCommand('date 08-03-07');
    const out = await ps('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4616})[0].Message');
    expect(out).toContain('The system time was changed.');
    expect(out).toMatch(/Name:\s+C:\\Windows\\System32\\cmd\.exe/);
    expect(out).toMatch(/New Time:\s+2007-08-03/);
  });

  it('a non-administrator is refused and the clock does not move', async () => {
    const before = await dateNow();
    pc.setCurrentUser('alice');
    const answer = await pc.executeCommand('date 08-03-07');
    pc.setCurrentUser('Administrator');
    expect(answer === '' ? 'accepted' : answer).not.toBe('accepted');
    expect(await dateNow()).toBe(before);
  });
});
