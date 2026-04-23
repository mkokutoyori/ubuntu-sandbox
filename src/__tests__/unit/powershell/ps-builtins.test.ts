/**
 * ps-builtins.test.ts — TDD tests for additional PowerShell 5.1 built-in cmdlets.
 *
 * Covers: Get-Date, Start-Sleep, Split-Path, Join-Path, Compare-Object,
 * Get-Unique, Select-String, ConvertTo-Csv, ConvertFrom-Csv, Test-Path (stub),
 * New-TimeSpan, Get-Member, Out-File (noop), Write-Progress (noop).
 */

import { describe, it, expect } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

function runAndGet(code: string, varName: string): unknown {
  const interp = new PSInterpreter();
  interp.execute(code);
  return interp.getVariable(varName);
}

function output(code: string): string {
  const interp = new PSInterpreter();
  return interp.execute(code);
}

// ─── 1. Get-Date ────────────────────────────────────────────────────────────

describe('Get-Date', () => {
  it('returns a Date-like object with Year/Month/Day/Hour/Minute/Second', () => {
    const r = runAndGet('$r = Get-Date', 'r') as Record<string, number>;
    expect(typeof r.Year).toBe('number');
    expect(typeof r.Month).toBe('number');
    expect(typeof r.Day).toBe('number');
    expect(typeof r.Hour).toBe('number');
    expect(typeof r.Minute).toBe('number');
    expect(typeof r.Second).toBe('number');
    expect(r.Year).toBeGreaterThanOrEqual(2024);
  });

  it('formats with -Format', () => {
    const r = runAndGet('$r = Get-Date -Format "yyyy"', 'r') as string;
    expect(r).toMatch(/^\d{4}$/);
  });

  it('formats MM-dd', () => {
    const r = runAndGet('$r = Get-Date -Format "MM-dd"', 'r') as string;
    expect(r).toMatch(/^\d{2}-\d{2}$/);
  });
});

// ─── 2. Start-Sleep ─────────────────────────────────────────────────────────

describe('Start-Sleep', () => {
  it('is a no-op (returns null) with -Seconds', () => {
    expect(runAndGet('$r = Start-Sleep -Seconds 0', 'r')).toBeNull();
  });

  it('is a no-op with -Milliseconds', () => {
    expect(runAndGet('$r = Start-Sleep -Milliseconds 0', 'r')).toBeNull();
  });
});

// ─── 3. Split-Path ──────────────────────────────────────────────────────────

describe('Split-Path', () => {
  it('returns parent directory by default', () => {
    expect(runAndGet('$r = Split-Path "C:\\Users\\Alice\\file.txt"', 'r')).toBe('C:\\Users\\Alice');
  });

  it('-Leaf returns the file name', () => {
    expect(runAndGet('$r = Split-Path "C:\\Users\\Alice\\file.txt" -Leaf', 'r')).toBe('file.txt');
  });

  it('-Parent returns the parent directory', () => {
    expect(runAndGet('$r = Split-Path "C:\\Users\\Alice\\file.txt" -Parent', 'r')).toBe('C:\\Users\\Alice');
  });

  it('-Extension returns the extension', () => {
    expect(runAndGet('$r = Split-Path "C:\\x\\file.txt" -Extension', 'r')).toBe('.txt');
  });

  it('handles forward slashes', () => {
    expect(runAndGet('$r = Split-Path "/usr/local/bin/foo" -Leaf', 'r')).toBe('foo');
  });
});

// ─── 4. Join-Path ───────────────────────────────────────────────────────────

describe('Join-Path', () => {
  it('joins two paths with a backslash by default', () => {
    expect(runAndGet('$r = Join-Path "C:\\Users" "Alice"', 'r')).toBe('C:\\Users\\Alice');
  });

  it('removes duplicate separators', () => {
    expect(runAndGet('$r = Join-Path "C:\\Users\\" "Alice"', 'r')).toBe('C:\\Users\\Alice');
  });

  it('joins with -ChildPath parameter', () => {
    expect(runAndGet('$r = Join-Path -Path "C:\\Users" -ChildPath "Alice"', 'r')).toBe('C:\\Users\\Alice');
  });
});

// ─── 5. Compare-Object ──────────────────────────────────────────────────────

describe('Compare-Object', () => {
  it('returns differences as objects with InputObject and SideIndicator', () => {
    const r = runAndGet(
      '$r = Compare-Object -ReferenceObject 1,2,3 -DifferenceObject 2,3,4',
      'r',
    ) as Array<{ InputObject: number; SideIndicator: string }>;
    expect(r).toEqual([
      { InputObject: 1, SideIndicator: '<=' },
      { InputObject: 4, SideIndicator: '=>' },
    ]);
  });

  it('returns empty array when identical', () => {
    const r = runAndGet(
      '$r = Compare-Object -ReferenceObject 1,2,3 -DifferenceObject 1,2,3',
      'r',
    ) as unknown[];
    expect(r).toEqual([]);
  });

  it('-IncludeEqual reports equals as well', () => {
    const r = runAndGet(
      '$r = Compare-Object -ReferenceObject 1,2 -DifferenceObject 2,3 -IncludeEqual',
      'r',
    ) as Array<{ InputObject: number; SideIndicator: string }>;
    expect(r).toContainEqual({ InputObject: 2, SideIndicator: '==' });
  });
});

// ─── 6. Get-Unique ──────────────────────────────────────────────────────────

describe('Get-Unique', () => {
  it('removes consecutive duplicates', () => {
    const r = runAndGet('$r = 1,1,2,3,3,3,4 | Get-Unique', 'r');
    expect(r).toEqual([1, 2, 3, 4]);
  });

  it('works with strings', () => {
    const r = runAndGet('$r = "a","a","b","c","c" | Get-Unique', 'r');
    expect(r).toEqual(['a', 'b', 'c']);
  });
});

// ─── 7. Select-String ───────────────────────────────────────────────────────

describe('Select-String', () => {
  it('finds lines matching a pattern in array input', () => {
    const r = runAndGet(
      '$r = "hello", "world", "help" | Select-String -Pattern "hel"',
      'r',
    ) as Array<{ Line: string; Pattern: string }>;
    expect(r.map(m => m.Line)).toEqual(['hello', 'help']);
    expect(r[0].Pattern).toBe('hel');
  });

  it('-SimpleMatch treats pattern as literal', () => {
    const r = runAndGet(
      '$r = "a.b", "ab" | Select-String -Pattern "." -SimpleMatch',
      'r',
    ) as Array<{ Line: string }>;
    expect(r.map(m => m.Line)).toEqual(['a.b']);
  });

  it('-NotMatch inverts the match', () => {
    const r = runAndGet(
      '$r = "foo", "bar", "baz" | Select-String -Pattern "foo" -NotMatch',
      'r',
    ) as Array<{ Line: string }>;
    expect(r.map(m => m.Line)).toEqual(['bar', 'baz']);
  });
});

// ─── 8. ConvertTo-Csv / ConvertFrom-Csv ─────────────────────────────────────

describe('CSV converters', () => {
  it('ConvertTo-Csv produces header + rows', () => {
    const csv = runAndGet(
      '$r = @(@{Name="Alice";Age=30}, @{Name="Bob";Age=25}) | ConvertTo-Csv -NoTypeInformation',
      'r',
    ) as string[];
    expect(csv[0]).toBe('"Name","Age"');
    expect(csv).toContain('"Alice","30"');
    expect(csv).toContain('"Bob","25"');
  });

  it('ConvertFrom-Csv parses back into hashtables', () => {
    const code =
      '$r = "Name,Age", "Alice,30", "Bob,25" | ConvertFrom-Csv';
    const r = runAndGet(code, 'r') as Array<Record<string, string>>;
    expect(r).toHaveLength(2);
    expect(r[0].Name).toBe('Alice');
    expect(r[0].Age).toBe('30');
    expect(r[1].Name).toBe('Bob');
  });
});

// ─── 9. New-TimeSpan ────────────────────────────────────────────────────────

describe('New-TimeSpan', () => {
  it('builds a timespan from -Seconds', () => {
    const r = runAndGet('$r = New-TimeSpan -Seconds 90', 'r') as Record<string, number>;
    expect(r.TotalSeconds).toBe(90);
    expect(r.Minutes).toBe(1);
    expect(r.Seconds).toBe(30);
  });

  it('builds a timespan from -Minutes', () => {
    const r = runAndGet('$r = New-TimeSpan -Minutes 2', 'r') as Record<string, number>;
    expect(r.TotalSeconds).toBe(120);
    expect(r.TotalMinutes).toBe(2);
  });
});

// ─── 10. Get-Member ─────────────────────────────────────────────────────────

describe('Get-Member', () => {
  it('lists properties of a hashtable', () => {
    const r = runAndGet(
      '$h = @{Name="Alice"; Age=30}; $r = $h | Get-Member',
      'r',
    ) as Array<{ Name: string; MemberType: string }>;
    const names = r.map(m => m.Name).sort();
    expect(names).toContain('Name');
    expect(names).toContain('Age');
  });

  it('-MemberType Property filters properties', () => {
    const r = runAndGet(
      '$h = @{A=1;B=2}; $r = $h | Get-Member -MemberType Property',
      'r',
    ) as Array<{ MemberType: string }>;
    for (const m of r) expect(m.MemberType).toBe('Property');
  });
});

// ─── 11. Pipeline noop-like cmdlets ─────────────────────────────────────────

describe('No-op cmdlets (logging / progress)', () => {
  it('Write-Progress returns null', () => {
    expect(runAndGet('$r = Write-Progress -Activity "x"', 'r')).toBeNull();
  });

  it('Write-Debug returns null', () => {
    expect(runAndGet('$r = Write-Debug "hello"', 'r')).toBeNull();
  });

  it('Write-Information returns null', () => {
    expect(runAndGet('$r = Write-Information "hello"', 'r')).toBeNull();
  });
});

// ─── 12. Pure output cmdlets pass-through ───────────────────────────────────

describe('Pass-through cmdlets', () => {
  it('Write-Output passes values through a pipeline', () => {
    const r = runAndGet(
      '$r = Write-Output 1,2,3 | ForEach-Object { $_ * 10 }',
      'r',
    );
    expect(r).toEqual([10, 20, 30]);
  });

  it('Echo is an alias for Write-Output', () => {
    expect(output('echo "hi"').trim()).toBe('hi');
  });
});

// ─── 13. Conversion helpers ─────────────────────────────────────────────────

describe('String / Number conversion cmdlets', () => {
  it('[string] cast on number', () => {
    expect(runAndGet('$r = [string]42', 'r')).toBe('42');
  });

  it('[int] cast on numeric string', () => {
    expect(runAndGet('$r = [int]"123"', 'r')).toBe(123);
  });

  it('[double] on int string', () => {
    expect(runAndGet('$r = [double]"3.5"', 'r')).toBe(3.5);
  });
});

// ─── 14. ForEach-Object advanced ─────────────────────────────────────────────

describe('ForEach-Object -Begin / -Process / -End', () => {
  it('runs -Begin before iteration', () => {
    const r = runAndGet(
      '$r = 1,2,3 | ForEach-Object -Begin { Write-Output "start" } -Process { $_ * 2 }',
      'r',
    );
    expect(r).toEqual(['start', 2, 4, 6]);
  });

  it('runs -End after iteration', () => {
    const r = runAndGet(
      '$r = 1,2,3 | ForEach-Object -Process { $_ } -End { Write-Output "done" }',
      'r',
    );
    expect(r).toEqual([1, 2, 3, 'done']);
  });
});
