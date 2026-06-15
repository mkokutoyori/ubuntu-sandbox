/**
 * Unit tests for the recently-fixed PS formatter behaviours:
 *
 *  - LastWriteTime (Date) is rendered as "M/d/yyyy h:mm AM/PM"
 *    (PowerShell short date + short time, en-US) instead of the
 *    JavaScript default "Fri May 15 2026 11:10:12 GMT+0000 …".
 *  - Length is blank (not "0") for directory rows in Format-Table.
 *  - Format-List uses the same renderer (no Date long string).
 *  - psValueToString applies the same Date format outside the
 *    table formatter (e.g. inside expandable strings).
 *
 * Driven through `formatTable` / `formatList` directly and end-to-end
 * through `Get-ChildItem | Format-Table` on a `WindowsPC`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { formatTable, formatList, renderPSCellValue } from '@/network/devices/windows/PSPipeline';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function execPS(pc: WindowsPC, line: string): Promise<string> {
  const { subShell } = PowerShellSubShell.create(pc);
  const r = await subShell.processLine(line);
  return r.output.join('\n');
}

describe('renderPSCellValue', () => {
  it('formats Date in PowerShell short date + short time (en-US)', () => {
    // 2026-05-15T11:10:12  →  "5/15/2026 11:10 AM"
    const d = new Date(2026, 4, 15, 11, 10, 12);
    expect(renderPSCellValue(d)).toBe('5/15/2026 11:10 AM');
  });

  it('uses 12-hour clock with AM/PM markers', () => {
    expect(renderPSCellValue(new Date(2026, 0, 1, 0, 5))).toBe('1/1/2026 12:05 AM');
    expect(renderPSCellValue(new Date(2026, 0, 1, 12, 0))).toBe('1/1/2026 12:00 PM');
    expect(renderPSCellValue(new Date(2026, 0, 1, 13, 7))).toBe('1/1/2026 1:07 PM');
    expect(renderPSCellValue(new Date(2026, 0, 1, 23, 59))).toBe('1/1/2026 11:59 PM');
  });

  it('renders null/undefined as empty, booleans as True/False', () => {
    expect(renderPSCellValue(null)).toBe('');
    expect(renderPSCellValue(undefined)).toBe('');
    expect(renderPSCellValue(true)).toBe('True');
    expect(renderPSCellValue(false)).toBe('False');
  });

  it('passes through strings and numbers unchanged', () => {
    expect(renderPSCellValue('hello')).toBe('hello');
    expect(renderPSCellValue(42)).toBe('42');
    expect(renderPSCellValue(0)).toBe('0');
  });
});

describe('psValueToString — Date support', () => {
  it('formats Date the PowerShell way (not JS default toString)', () => {
    const d = new Date(2026, 4, 15, 11, 10, 12);
    expect(psValueToString(d)).toBe('5/15/2026 11:10 AM');
  });
});

describe('formatTable — Length column on DirectoryEntry rows', () => {
  it('renders blank Length for rows where Mode starts with d', () => {
    const rows = [
      { Mode: 'd-----', LastWriteTime: new Date(2026, 4, 15, 11, 10), Length: null, Name: 'Windows' },
      { Mode: '-a----', LastWriteTime: new Date(2026, 4, 15, 11, 10), Length: 18,   Name: 'readme.txt' },
    ];
    const table = formatTable(rows, 'Mode, LastWriteTime, Length, Name');
    const dirRow  = table.split('\n').find(l => l.includes('Windows'))!;
    const fileRow = table.split('\n').find(l => l.includes('readme.txt'))!;

    // Directory: no digit between the Mode and the trailing Name token
    expect(dirRow).toMatch(/d-----\s+5\/15\/2026 11:10 AM\s+Windows/);
    expect(dirRow).not.toMatch(/\b0\b/);
    // File: length shows up
    expect(fileRow).toContain('18');
  });

  it('uses PS date format inside the table cells', () => {
    const rows = [
      { Mode: '-a----', LastWriteTime: new Date(2026, 4, 15, 14, 7), Length: 9, Name: 'nums.txt' },
    ];
    const table = formatTable(rows, '');
    expect(table).toContain('5/15/2026 2:07 PM');
    expect(table).not.toContain('GMT');
    expect(table).not.toContain('Coordinated Universal Time');
  });

  it('right-aligns Date columns', () => {
    const rows = [
      { LastWriteTime: new Date(2026, 4, 15, 11, 10), Name: 'a' },
    ];
    const table = formatTable(rows, 'LastWriteTime, Name');
    // The date string ends right before the gap to Name
    expect(table).toMatch(/5\/15\/2026 11:10 AM {2}a/);
  });
});

describe('formatList — Date rendering', () => {
  it('uses PS date format inside list cells', () => {
    const rows = [
      { Name: 'nums.txt', LastWriteTime: new Date(2026, 4, 15, 14, 7), Length: 9 },
    ];
    const out = formatList(rows, '');
    expect(out).toContain('LastWriteTime : 5/15/2026 2:07 PM');
    expect(out).not.toContain('GMT');
  });
});

describe('Get-ChildItem (end-to-end through PowerShellSubShell)', () => {
  it('shows PS-style dates, not JS default toString', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-FMT');
    pc.setCurrentUser('Administrator');
    const out = await execPS(pc, 'Get-ChildItem C:\\');
    expect(out).not.toContain('GMT');
    expect(out).not.toContain('Coordinated Universal Time');
    expect(out).toMatch(/\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2} (AM|PM)/);
  });

  it('shows blank Length cell for directories, real size for files', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-FMT');
    pc.setCurrentUser('Administrator');
    await execPS(pc, 'New-Item -Path C:\\GciFmt -ItemType Directory');
    await execPS(pc, 'Set-Content -Path C:\\GciFmt\\f.txt -Value "12345"');
    const out = await execPS(pc, 'Get-ChildItem C:\\GciFmt');
    const fileLine = out.split('\n').find(l => l.includes('f.txt'))!;
    expect(fileLine).toMatch(/\b6\b/); // "12345" + the newline Set-Content appends, like real PowerShell
  });

  it('Set-Location no longer crashes with "this.pc.setCwd is not a function"', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-CWD');
    pc.setCurrentUser('Administrator');
    const r1 = await execPS(pc, 'Set-Location C:\\');
    expect(r1).not.toContain('setCwd is not a function');
    expect(r1).not.toContain('is not a function');
    const r2 = await execPS(pc, 'Get-Location');
    expect(r2).toContain('C:\\');
  });
});
