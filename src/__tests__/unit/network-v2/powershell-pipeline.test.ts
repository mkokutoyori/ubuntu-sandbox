/**
 * PowerShell Pipeline Engine — Unit Tests (40+ scenarios)
 *
 * Tests the object-based pipeline engine (PSPipeline.ts) and its integration
 * with PowerShellExecutor. Covers:
 *   - Table / key-value block parsing
 *   - Where-Object with all comparison operators
 *   - Select-Object (projection, -First, -Last, -Skip, -Unique, -ExpandProperty)
 *   - Sort-Object (ascending, descending, multi-property)
 *   - Measure-Object (Count, Sum, Average, Min, Max)
 *   - Select-String (regex, -SimpleMatch, -CaseSensitive, -NotMatch)
 *   - Format-Table / Format-List
 *   - Full pipeline chaining (multi-stage)
 *   - Integration with PowerShellExecutor (Get-Process, Get-Service, Get-Command)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseTable,
  parseKeyValueBlocks,
  whereObject,
  selectObject,
  sortObject,
  measureObject,
  selectString,
  formatTable,
  formatList,
  formatDefault,
  runPipeline,
  applyPipelineStage,
  buildProcessObjects,
  buildServiceObjects,
  buildCommandObjects,
  parseWhereCondition,
  type PSObject,
} from '@/network/devices/windows/PSPipeline';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellExecutor } from '@/network/devices/windows/PowerShellExecutor';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function createPSExecutor(): { pc: WindowsPC; ps: PowerShellExecutor } {
  const pc = new WindowsPC('windows-pc', 'PC1', 100, 100);
  const ps = new PowerShellExecutor(pc as any);
  return { pc, ps };
}

// ═══════════════════════════════════════════════════════════════════
// Group 1: Table and Key-Value Parsing
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: Table and Key-Value Parsing', () => {

  it('PSP-01: parseTable extracts objects from well-formed table', () => {
    const table = `Name        Age   City
----        ---   ----
Alice       30    Paris
Bob         25    London
Charlie     35    Berlin`;

    const result = parseTable(table);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);
    expect(result![0].Name).toBe('Alice');
    expect(result![0].Age).toBe(30);
    expect(result![0].City).toBe('Paris');
    expect(result![2].Name).toBe('Charlie');
  });

  it('PSP-02: parseTable returns null for insufficient lines', () => {
    expect(parseTable('just one line')).toBeNull();
    expect(parseTable('')).toBeNull();
  });

  it('PSP-03: parseTable handles numeric coercion correctly', () => {
    const table = `Value   Flag
-----   ----
42      True
0       False
hello   null`;

    const result = parseTable(table);
    expect(result).not.toBeNull();
    expect(result![0].Value).toBe(42);
    expect(result![0].Flag).toBe(true);
    expect(result![1].Value).toBe(0);
    expect(result![1].Flag).toBe(false);
    expect(result![2].Value).toBe('hello');
    expect(result![2].Flag).toBeNull();
  });

  it('PSP-04: parseKeyValueBlocks parses Format-List style output', () => {
    const text = `Name  : Alice
Age   : 30
City  : Paris

Name  : Bob
Age   : 25
City  : London`;

    const result = parseKeyValueBlocks(text);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0].Name).toBe('Alice');
    expect(result![0].Age).toBe(30);
    expect(result![1].Name).toBe('Bob');
    expect(result![1].City).toBe('London');
  });

  it('PSP-05: parseKeyValueBlocks returns null for empty input', () => {
    expect(parseKeyValueBlocks('')).toBeNull();
    expect(parseKeyValueBlocks('   \n   ')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 2: Where-Object Filtering
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: Where-Object Filtering', () => {

  const testData: PSObject[] = [
    { Name: 'Alice', Age: 30, City: 'Paris' },
    { Name: 'Bob', Age: 25, City: 'London' },
    { Name: 'Charlie', Age: 35, City: 'Berlin' },
    { Name: 'Diana', Age: 28, City: 'Paris' },
  ];

  it('PSP-06: Where-Object -eq filters by exact match (case-insensitive)', () => {
    const result = whereObject(testData, "{ $_.City -eq 'Paris' }");
    expect(result).toHaveLength(2);
    expect(result[0].Name).toBe('Alice');
    expect(result[1].Name).toBe('Diana');
  });

  it('PSP-07: Where-Object -ne filters by inequality', () => {
    const result = whereObject(testData, "{ $_.City -ne 'Paris' }");
    expect(result).toHaveLength(2);
    expect(result[0].Name).toBe('Bob');
    expect(result[1].Name).toBe('Charlie');
  });

  it('PSP-08: Where-Object -gt filters by greater-than', () => {
    const result = whereObject(testData, '{ $_.Age -gt 28 }');
    expect(result).toHaveLength(2);
    expect(result.map(r => r.Name)).toEqual(['Alice', 'Charlie']);
  });

  it('PSP-09: Where-Object -lt filters by less-than', () => {
    const result = whereObject(testData, '{ $_.Age -lt 30 }');
    expect(result).toHaveLength(2);
    expect(result.map(r => r.Name)).toEqual(['Bob', 'Diana']);
  });

  it('PSP-10: Where-Object -ge filters by greater-or-equal', () => {
    const result = whereObject(testData, '{ $_.Age -ge 30 }');
    expect(result).toHaveLength(2);
    expect(result.map(r => r.Name)).toEqual(['Alice', 'Charlie']);
  });

  it('PSP-11: Where-Object -le filters by less-or-equal', () => {
    const result = whereObject(testData, '{ $_.Age -le 28 }');
    expect(result).toHaveLength(2);
    expect(result.map(r => r.Name)).toEqual(['Bob', 'Diana']);
  });

  it('PSP-12: Where-Object -like with wildcard pattern', () => {
    const result = whereObject(testData, "{ $_.Name -like 'A*' }");
    expect(result).toHaveLength(1);
    expect(result[0].Name).toBe('Alice');
  });

  it('PSP-13: Where-Object -notlike excludes matching', () => {
    const result = whereObject(testData, "{ $_.Name -notlike 'A*' }");
    expect(result).toHaveLength(3);
    expect(result.every(r => r.Name !== 'Alice')).toBe(true);
  });

  it('PSP-14: Where-Object -match with regex', () => {
    const result = whereObject(testData, "{ $_.Name -match '^[A-B]' }");
    expect(result).toHaveLength(2);
    expect(result.map(r => r.Name)).toEqual(['Alice', 'Bob']);
  });

  it('PSP-15: Where-Object -notmatch excludes regex matches', () => {
    const result = whereObject(testData, "{ $_.Name -notmatch '^[A-B]' }");
    expect(result).toHaveLength(2);
    expect(result.map(r => r.Name)).toEqual(['Charlie', 'Diana']);
  });

  it('PSP-16: Where-Object -contains checks substring', () => {
    const result = whereObject(testData, "{ $_.City -contains 'on' }");
    expect(result).toHaveLength(1);
    expect(result[0].Name).toBe('Bob');
  });

  it('PSP-17: Where-Object truthy check (property exists and is truthy)', () => {
    const data: PSObject[] = [
      { Name: 'A', Active: true },
      { Name: 'B', Active: false },
      { Name: 'C', Active: null },
    ];
    const result = whereObject(data, '{ $_.Active }');
    expect(result).toHaveLength(1);
    expect(result[0].Name).toBe('A');
  });

  it('PSP-18: Where-Object simplified syntax without braces', () => {
    const result = whereObject(testData, "Name -eq 'Bob'");
    expect(result).toHaveLength(1);
    expect(result[0].Name).toBe('Bob');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 3: Select-Object
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: Select-Object', () => {

  const testData: PSObject[] = [
    { Name: 'Alice', Age: 30, City: 'Paris' },
    { Name: 'Bob', Age: 25, City: 'London' },
    { Name: 'Charlie', Age: 35, City: 'Berlin' },
    { Name: 'Diana', Age: 28, City: 'Paris' },
    { Name: 'Eve', Age: 22, City: 'Madrid' },
  ];

  it('PSP-19: Select-Object -Property projects specific columns', () => {
    const result = selectObject(testData, '-Property Name, Age');
    expect(result).toHaveLength(5);
    expect(Object.keys(result[0])).toEqual(['Name', 'Age']);
    expect(result[0].Name).toBe('Alice');
    expect(result[0].Age).toBe(30);
  });

  it('PSP-20: Select-Object -First takes first N', () => {
    const result = selectObject(testData, '-First 2');
    expect(result).toHaveLength(2);
    expect(result[0].Name).toBe('Alice');
    expect(result[1].Name).toBe('Bob');
  });

  it('PSP-21: Select-Object -Last takes last N', () => {
    const result = selectObject(testData, '-Last 2');
    expect(result).toHaveLength(2);
    expect(result[0].Name).toBe('Diana');
    expect(result[1].Name).toBe('Eve');
  });

  it('PSP-22: Select-Object -Skip skips first N', () => {
    const result = selectObject(testData, '-Skip 3');
    expect(result).toHaveLength(2);
    expect(result[0].Name).toBe('Diana');
  });

  it('PSP-23: Select-Object -Unique removes duplicates', () => {
    const data: PSObject[] = [
      { City: 'Paris' },
      { City: 'London' },
      { City: 'Paris' },
      { City: 'Berlin' },
    ];
    const result = selectObject(data, '-Unique');
    expect(result).toHaveLength(3);
  });

  it('PSP-24: Select-Object -ExpandProperty extracts single property', () => {
    const result = selectObject(testData, '-ExpandProperty Name');
    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({ Name: 'Alice' });
    expect(result[4]).toEqual({ Name: 'Eve' });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 4: Sort-Object
// ═══════════════════════════════════════════════════════════════════

describe('Group 4: Sort-Object', () => {

  const testData: PSObject[] = [
    { Name: 'Charlie', Age: 35 },
    { Name: 'Alice', Age: 30 },
    { Name: 'Bob', Age: 25 },
  ];

  it('PSP-25: Sort-Object by property ascending (default)', () => {
    const result = sortObject(testData, 'Name');
    expect(result.map(r => r.Name)).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('PSP-26: Sort-Object -Descending reverses order', () => {
    const result = sortObject(testData, '-Property Age -Descending');
    expect(result.map(r => r.Age)).toEqual([35, 30, 25]);
  });

  it('PSP-27: Sort-Object by numeric property ascending', () => {
    const result = sortObject(testData, 'Age');
    expect(result.map(r => r.Age)).toEqual([25, 30, 35]);
  });

  it('PSP-28: Sort-Object with no args sorts by string representation', () => {
    const result = sortObject(testData, '');
    expect(result).toHaveLength(3);
    // Should still produce a valid sorted array (no crash)
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 5: Measure-Object
// ═══════════════════════════════════════════════════════════════════

describe('Group 5: Measure-Object', () => {

  const testData: PSObject[] = [
    { Name: 'A', Value: 10 },
    { Name: 'B', Value: 20 },
    { Name: 'C', Value: 30 },
    { Name: 'D', Value: 40 },
  ];

  it('PSP-29: Measure-Object counts objects', () => {
    const result = measureObject(testData, '');
    expect(result).toContain('Count    : 4');
  });

  it('PSP-30: Measure-Object -Sum computes sum', () => {
    const result = measureObject(testData, '-Property Value -Sum');
    expect(result).toContain('Sum      : 100');
    expect(result).toContain('Count    : 4');
  });

  it('PSP-31: Measure-Object -Average computes average', () => {
    const result = measureObject(testData, '-Property Value -Average');
    expect(result).toContain('Average  : 25');
  });

  it('PSP-32: Measure-Object -Minimum / -Maximum', () => {
    const result = measureObject(testData, '-Property Value -Minimum -Maximum');
    expect(result).toContain('Maximum  : 40');
    expect(result).toContain('Minimum  : 10');
  });

  it('PSP-33: Measure-Object with no flags shows all stats', () => {
    const result = measureObject(testData, '-Property Value');
    expect(result).toContain('Count    : 4');
    expect(result).toContain('Average  : 25');
    expect(result).toContain('Sum      : 100');
    expect(result).toContain('Maximum  : 40');
    expect(result).toContain('Minimum  : 10');
    expect(result).toContain('Property : Value');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 6: Select-String
// ═══════════════════════════════════════════════════════════════════

describe('Group 6: Select-String', () => {

  const testData: PSObject[] = [
    { Line: 'Hello World' },
    { Line: 'Goodbye World' },
    { Line: 'Hello Python' },
    { Line: 'Goodbye Ruby' },
  ];

  it('PSP-34: Select-String filters by regex pattern', () => {
    const result = selectString(testData, '-Pattern Hello');
    expect(result).toHaveLength(2);
    expect(result[0].Line).toBe('Hello World');
    expect(result[1].Line).toBe('Hello Python');
  });

  it('PSP-35: Select-String -SimpleMatch uses literal substring', () => {
    const result = selectString(testData, '-Pattern Hello -SimpleMatch');
    expect(result).toHaveLength(2);
  });

  it('PSP-36: Select-String -NotMatch inverts the match', () => {
    const result = selectString(testData, '-Pattern Hello -NotMatch');
    expect(result).toHaveLength(2);
    expect(result[0].Line).toBe('Goodbye World');
    expect(result[1].Line).toBe('Goodbye Ruby');
  });

  it('PSP-37: Select-String -CaseSensitive respects case', () => {
    const result = selectString(testData, '-Pattern hello -CaseSensitive');
    expect(result).toHaveLength(0); // "hello" vs "Hello"

    const result2 = selectString(testData, '-Pattern Hello -CaseSensitive');
    expect(result2).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 7: Format-Table / Format-List / formatDefault
// ═══════════════════════════════════════════════════════════════════

describe('Group 7: Formatters', () => {

  const testData: PSObject[] = [
    { Name: 'Alice', Age: 30 },
    { Name: 'Bob', Age: 25 },
  ];

  it('PSP-38: Format-Table produces aligned table with headers and dashes', () => {
    const result = formatTable(testData, '');
    expect(result).toContain('Name');
    expect(result).toContain('Age');
    expect(result).toContain('----');
    expect(result).toContain('Alice');
    expect(result).toContain('Bob');
  });

  it('PSP-39: Format-Table -Property selects specific columns', () => {
    const data: PSObject[] = [
      { Name: 'Alice', Age: 30, City: 'Paris' },
    ];
    const result = formatTable(data, '-Property Name, City');
    expect(result).toContain('Name');
    expect(result).toContain('City');
    expect(result).not.toContain('Age');
  });

  it('PSP-40: Format-List produces key-value pairs', () => {
    const result = formatList(testData, '');
    expect(result).toContain('Name : Alice');
    expect(result).toContain('Age  : 30');
    expect(result).toContain('Name : Bob');
  });

  it('PSP-41: Format-List -Property selects specific keys', () => {
    const data: PSObject[] = [
      { Name: 'Alice', Age: 30, City: 'Paris' },
    ];
    const result = formatList(data, '-Property Name, City');
    expect(result).toContain('Name : Alice');
    expect(result).toContain('City : Paris');
    expect(result).not.toContain('Age');
  });

  it('PSP-42: formatDefault uses table for <=4 props, list for >4', () => {
    const small: PSObject[] = [{ A: 1, B: 2 }];
    const large: PSObject[] = [{ A: 1, B: 2, C: 3, D: 4, E: 5 }];

    const tableResult = formatDefault(small);
    // Table format has header + separator line with dashes
    expect(tableResult).toContain('A');
    expect(tableResult).toContain('B');
    expect(tableResult).toContain('-'); // separator dashes

    const listResult = formatDefault(large);
    expect(listResult).toContain(' : '); // list has key : value format
  });

  it('PSP-43: formatTable returns empty string for empty input', () => {
    expect(formatTable([], '')).toBe('');
  });

  it('PSP-44: formatList returns empty string for empty input', () => {
    expect(formatList([], '')).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 8: Full Pipeline Chaining
// ═══════════════════════════════════════════════════════════════════

describe('Group 8: Full Pipeline Chaining', () => {

  it('PSP-45: Pipeline: Where-Object | Select-Object', () => {
    const procs = buildProcessObjects();
    const result = runPipeline(procs, [
      "Where-Object { $_.Id -gt 1000 }",
      "Select-Object -Property ProcessName, Id",
    ]);
    expect(result).toContain('ProcessName');
    expect(result).toContain('Id');
    expect(result).toContain('explorer');
    expect(result).not.toContain('smss'); // Id 340 < 1000
  });

  it('PSP-46: Pipeline: Sort-Object | Select-Object -First 3', () => {
    const procs = buildProcessObjects();
    const result = runPipeline(procs, [
      "Sort-Object -Property Id",
      "Select-Object -First 3",
    ]);
    expect(result).toContain('System'); // Id=4, smallest
  });

  it('PSP-47: Pipeline: Where-Object | Measure-Object', () => {
    const services = buildServiceObjects();
    const result = runPipeline(services, [
      "Where-Object { $_.Status -eq 'Running' }",
      "Measure-Object",
    ]);
    expect(result).toContain('Count    : 10');
  });

  it('PSP-48: Pipeline: Where-Object | Sort-Object | Format-Table', () => {
    const procs = buildProcessObjects();
    const result = runPipeline(procs, [
      "Where-Object { $_.Handles -gt 500 }",
      "Sort-Object -Property Handles -Descending",
      "Format-Table -Property ProcessName, Handles",
    ]);
    expect(result).toContain('ProcessName');
    expect(result).toContain('Handles');
    expect(result).toContain('explorer'); // 2456 handles
    // explorer (2456) should appear before dwm (1258) since descending
    const explorerIdx = result.indexOf('explorer');
    const dwmIdx = result.indexOf('dwm');
    expect(explorerIdx).toBeLessThan(dwmIdx);
  });

  it('PSP-49: Pipeline: string input auto-parses into table', () => {
    const tableStr = `Status   Name            DisplayName
------   ----            -----------
Running  Dhcp            DHCP Client
Running  Dnscache        DNS Client
Stopped  Spooler         Print Spooler`;

    const result = runPipeline(tableStr, [
      "Where-Object { $_.Status -eq 'Running' }",
    ]);
    expect(result).toContain('Dhcp');
    expect(result).toContain('Dnscache');
    expect(result).not.toContain('Spooler');
  });

  it('PSP-50: Pipeline: string input falls back to line-based objects', () => {
    const text = 'line one\nline two\nline three';
    const result = runPipeline(text, [
      "Select-String -Pattern 'two'",
    ]);
    expect(result).toContain('line two');
    expect(result).not.toContain('line one');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 9: applyPipelineStage aliases
// ═══════════════════════════════════════════════════════════════════

describe('Group 9: Pipeline stage aliases', () => {

  const data: PSObject[] = [
    { Name: 'A', Value: 1 },
    { Name: 'B', Value: 2 },
    { Name: 'C', Value: 3 },
  ];

  it('PSP-51: ? alias works for Where-Object', () => {
    const result = applyPipelineStage(data, "? { $_.Value -gt 1 }");
    expect(Array.isArray(result.output)).toBe(true);
    expect((result.output as PSObject[]).length).toBe(2);
  });

  it('PSP-52: ft alias works for Format-Table', () => {
    const result = applyPipelineStage(data, 'ft -Property Name');
    expect(result.formatted).toBeDefined();
    expect(result.formatted).toContain('Name');
    expect(result.formatted).not.toContain('Value');
  });

  it('PSP-53: fl alias works for Format-List', () => {
    const result = applyPipelineStage(data, 'fl');
    expect(result.formatted).toBeDefined();
    expect(result.formatted).toMatch(/Name\s+: A/);
  });

  it('PSP-54: sls alias works for Select-String', () => {
    const result = applyPipelineStage(data, "sls -Pattern 'B'");
    expect(Array.isArray(result.output)).toBe(true);
    expect((result.output as PSObject[]).length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 10: Structured cmdlet output builders
// ═══════════════════════════════════════════════════════════════════

describe('Group 10: Structured cmdlet builders', () => {

  it('PSP-55: buildProcessObjects returns valid process data', () => {
    const procs = buildProcessObjects();
    expect(procs.length).toBeGreaterThan(5);
    expect(procs[0]).toHaveProperty('ProcessName');
    expect(procs[0]).toHaveProperty('Id');
    expect(procs[0]).toHaveProperty('Handles');
    expect(typeof procs[0].Id).toBe('number');
  });

  it('PSP-56: buildServiceObjects returns valid service data', () => {
    const services = buildServiceObjects();
    expect(services.length).toBeGreaterThan(5);
    expect(services[0]).toHaveProperty('Status');
    expect(services[0]).toHaveProperty('Name');
    expect(services[0]).toHaveProperty('DisplayName');
  });

  it('PSP-57: buildCommandObjects returns valid command data', () => {
    const cmds = buildCommandObjects();
    expect(cmds.length).toBeGreaterThan(5);
    expect(cmds[0]).toHaveProperty('CommandType');
    expect(cmds[0]).toHaveProperty('Name');
    expect(cmds[0]).toHaveProperty('Source');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 11: Integration with PowerShellExecutor
// ═══════════════════════════════════════════════════════════════════

describe('Group 11: PowerShellExecutor pipeline integration', () => {

  it('PSP-58: Get-Process | Where-Object filters processes', async () => {
    const { ps } = createPSExecutor();
    const result = await ps.execute("Get-Process | Where-Object { $_.ProcessName -eq 'explorer' }");
    expect(result).toContain('explorer');
    expect(result).not.toContain('smss');
  });

  it('PSP-59: Get-Process | Select-Object -First 3 limits output', async () => {
    const { ps } = createPSExecutor();
    const result = await ps.execute('Get-Process | Select-Object -First 3');
    // The pipeline should produce at most 3 data rows in the table
    // Count process names in the output
    const procs = buildProcessObjects();
    const allNames = procs.map(p => String(p.ProcessName));
    let foundCount = 0;
    for (const name of allNames) {
      if (result.includes(name)) foundCount++;
    }
    expect(foundCount).toBeLessThanOrEqual(3);
  });

  it('PSP-60: Get-Process | Sort-Object Id sorts by process ID', async () => {
    const { ps } = createPSExecutor();
    const result = await ps.execute('Get-Process | Sort-Object Id | Select-Object -First 2');
    // System (Id=4) should appear first
    expect(result).toContain('System');
  });

  it('PSP-61: Get-Process | Measure-Object returns count', async () => {
    const { ps } = createPSExecutor();
    const result = await ps.execute('Get-Process | Measure-Object');
    expect(result).toContain('Count');
    expect(result).toMatch(/Count\s+:\s+\d+/);
  });

  it('PSP-62: Get-Service | Where-Object filters services', async () => {
    const { ps } = createPSExecutor();
    const result = await ps.execute("Get-Service | Where-Object { $_.Name -like 'D*' }");
    expect(result).toContain('Dhcp');
    expect(result).toContain('Dnscache');
    expect(result).not.toContain('WinRM');
  });

  it('PSP-63: Get-Service | Format-List shows key-value pairs', async () => {
    const { ps } = createPSExecutor();
    const result = await ps.execute('Get-Service | Format-List');
    expect(result).toContain(' : ');
    expect(result).toContain('Running');
  });

  it('PSP-64: Get-Command | Select-Object -Property Name shows only names', async () => {
    const { ps } = createPSExecutor();
    const result = await ps.execute('Get-Command | Select-Object -Property Name');
    expect(result).toContain('Name');
    expect(result).toContain('Get-ChildItem');
    // Should NOT show CommandType column in output
    // (the objects only have Name, so Format-Table will only show Name)
    const lines = result.split('\n');
    const headerLine = lines.find(l => l.includes('Name') && !l.includes('---'));
    if (headerLine) {
      expect(headerLine).not.toContain('CommandType');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 12: Edge Cases and Robustness
// ═══════════════════════════════════════════════════════════════════

describe('Group 12: Edge Cases', () => {

  it('PSP-65: Where-Object with unknown condition returns all objects', () => {
    const data: PSObject[] = [{ A: 1 }, { A: 2 }];
    const condition = parseWhereCondition('some_unknown_syntax');
    const result = data.filter(condition);
    expect(result).toHaveLength(2); // fallback: always true
  });

  it('PSP-66: Measure-Object with no numeric values returns 0', () => {
    const data: PSObject[] = [
      { Name: 'A' },
      { Name: 'B' },
    ];
    const result = measureObject(data, '-Property Name -Sum');
    expect(result).toContain('Sum      : 0');
  });

  it('PSP-67: Select-Object with -Skip larger than array returns empty', () => {
    const data: PSObject[] = [{ A: 1 }, { A: 2 }];
    const result = selectObject(data, '-Skip 10');
    expect(result).toHaveLength(0);
  });

  it('PSP-68: Format-Table right-aligns numeric values', () => {
    const data: PSObject[] = [
      { Name: 'Short', Value: 5 },
      { Name: 'VeryLong', Value: 12345 },
    ];
    const result = formatTable(data, '');
    // Numbers should be right-aligned — the 5 should have spaces before it
    const lines = result.split('\n').filter(l => l.includes('Short'));
    expect(lines.length).toBe(1);
    // 5 should appear after some spaces (right-aligned vs 12345)
    expect(lines[0]).toMatch(/\s+5/);
  });

  it('PSP-69: runPipeline with empty filter array returns formatted input', () => {
    const data: PSObject[] = [{ X: 1 }, { X: 2 }];
    const result = runPipeline(data, []);
    expect(result).toContain('X');
    expect(result).toContain('1');
    expect(result).toContain('2');
  });

  it('PSP-70: Pipeline handles Format-Table in middle (subsequent stage processes string)', () => {
    const data: PSObject[] = [
      { Name: 'Alpha', Value: 10 },
      { Name: 'Beta', Value: 20 },
    ];
    // Format-Table produces string, then Select-String processes lines
    const result = runPipeline(data, [
      'Format-Table',
      "Select-String -Pattern 'Alpha'",
    ]);
    expect(result).toContain('Alpha');
  });
});
