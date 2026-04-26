/**
 * Category: Variables, arithmetic, string operations
 *
 * Probes $PSVersionTable, automatic variables ($home, $env:, $pid…),
 * arithmetic expressions, string interpolation, and basic .NET methods.
 */

import type { DiagnosticCase } from '../types';
import { assert } from '../engine';

export const variableChecks: DiagnosticCase[] = [

  // ─── $PSVersionTable ─────────────────────────────────────────────
  {
    id: 'VAR-001', category: 'Variables',
    description: '$PSVersionTable contains PSVersion key',
    cmd: '$PSVersionTable',
    assert: assert.contains('PSVersion'),
    severity: 'FAIL',
  },
  {
    id: 'VAR-002', category: 'Variables',
    description: '$PSVersionTable.PSVersion returns version string',
    cmd: '$PSVersionTable.PSVersion',
    assert: assert.matches(/^\d+\.\d+/),
    severity: 'FAIL',
  },

  // ─── Automatic variables ─────────────────────────────────────────
  {
    id: 'VAR-003', category: 'Variables',
    description: '$home resolves to user home directory',
    cmd: '$home',
    assert: assert.matches(/C:\\Users\\/i),
    severity: 'WARN',
    psNote: 'Real PS: C:\\Users\\<username>',
  },
  {
    id: 'VAR-004', category: 'Variables',
    description: '$env:USERNAME returns a non-empty string',
    cmd: '$env:USERNAME',
    assert: assert.notEmpty(),
    severity: 'WARN',
  },
  {
    id: 'VAR-005', category: 'Variables',
    description: '$env:COMPUTERNAME returns a non-empty string',
    cmd: '$env:COMPUTERNAME',
    assert: assert.notEmpty(),
    severity: 'WARN',
  },
  {
    id: 'VAR-006', category: 'Variables',
    description: '$env:TEMP / $env:TMP resolves to a path',
    cmd: '$env:TEMP',
    assert: assert.notEmpty(),
    severity: 'WARN',
    psNote: 'Real PS: C:\\Users\\<user>\\AppData\\Local\\Temp',
  },
  {
    id: 'VAR-007', category: 'Variables',
    description: '$pid returns a numeric process ID',
    cmd: '$pid',
    assert: assert.matches(/^\d+$/),
    severity: 'WARN',
  },
  {
    id: 'VAR-008', category: 'Variables',
    description: '$null is truly null / empty',
    cmd: '$null -eq $null',
    assert: assert.contains('True'),
    severity: 'FAIL',
  },
  {
    id: 'VAR-009', category: 'Variables',
    description: '$true and $false are boolean literals',
    cmd: '$true; $false',
    assert: assert.all(assert.contains('True'), assert.contains('False')),
    severity: 'FAIL',
  },

  // ─── User variable assignment ─────────────────────────────────────
  {
    id: 'VAR-010', category: 'Variables',
    description: 'Assigning and reading a scalar variable',
    cmd: '$x = 42; $x',
    assert: assert.contains('42'),
    severity: 'FAIL',
  },
  {
    id: 'VAR-011', category: 'Variables',
    description: 'String interpolation inside double quotes',
    cmd: '$name = "World"; "Hello $name"',
    assert: assert.contains('Hello World'),
    severity: 'FAIL',
  },
  {
    id: 'VAR-012', category: 'Variables',
    description: 'Single-quoted strings are NOT interpolated',
    cmd: "$name = 'World'; 'Hello $name'",
    assert: assert.exact('Hello $name'),
    severity: 'FAIL',
  },
  {
    id: 'VAR-013', category: 'Variables',
    description: '$() subexpression inside a string',
    cmd: '$n = 3; "Result: $($n * 2)"',
    assert: assert.contains('Result: 6'),
    severity: 'FAIL',
  },

  // ─── Arithmetic ──────────────────────────────────────────────────
  {
    id: 'VAR-014', category: 'Variables',
    description: 'Integer addition',
    cmd: '1 + 2',
    assert: assert.exact('3'),
    severity: 'FAIL',
  },
  {
    id: 'VAR-015', category: 'Variables',
    description: 'Integer subtraction and multiplication',
    cmd: '10 - 3 * 2',
    assert: assert.exact('4'),
    severity: 'FAIL',
    psNote: 'Real PS evaluates left-to-right without precedence? No — * has precedence: 10-6=4',
  },
  {
    id: 'VAR-016', category: 'Variables',
    description: 'Integer division (floor)',
    cmd: '7 / 2',
    assert: assert.matches(/^3\.?5?$/),
    severity: 'WARN',
    psNote: 'Real PS: 7/2 = 3.5 (not integer division)',
  },
  {
    id: 'VAR-017', category: 'Variables',
    description: 'Modulo operator',
    cmd: '10 % 3',
    assert: assert.exact('1'),
    severity: 'FAIL',
  },
  {
    id: 'VAR-018', category: 'Variables',
    description: 'Parentheses override precedence',
    cmd: '(2 + 3) * 4',
    assert: assert.exact('20'),
    severity: 'FAIL',
  },
  {
    id: 'VAR-019', category: 'Variables',
    description: 'Compound assignment +=',
    cmd: '$v = 5; $v += 3; $v',
    assert: assert.exact('8'),
    severity: 'FAIL',
  },
  {
    id: 'VAR-020', category: 'Variables',
    description: '[math]::Pow is available',
    cmd: '[math]::Pow(2,10)',
    assert: assert.contains('1024'),
    severity: 'WARN',
  },
  {
    id: 'VAR-021', category: 'Variables',
    description: '[math]::Round rounds correctly',
    cmd: '[math]::Round(3.7)',
    assert: assert.exact('4'),
    severity: 'WARN',
  },
  {
    id: 'VAR-022', category: 'Variables',
    description: '[int]::MaxValue',
    cmd: '[int]::MaxValue',
    assert: assert.contains('2147483647'),
    severity: 'WARN',
  },

  // ─── String methods ───────────────────────────────────────────────
  {
    id: 'VAR-023', category: 'Variables',
    description: '"hello".ToUpper()',
    cmd: '"hello".ToUpper()',
    assert: assert.exact('HELLO'),
    severity: 'FAIL',
  },
  {
    id: 'VAR-024', category: 'Variables',
    description: '"HELLO".ToLower()',
    cmd: '"HELLO".ToLower()',
    assert: assert.exact('hello'),
    severity: 'FAIL',
  },
  {
    id: 'VAR-025', category: 'Variables',
    description: '"hello world".Length',
    cmd: '"hello world".Length',
    assert: assert.exact('11'),
    severity: 'FAIL',
  },
  {
    id: 'VAR-026', category: 'Variables',
    description: '"hello".Contains("ell")',
    cmd: '"hello".Contains("ell")',
    assert: assert.contains('True'),
    severity: 'WARN',
  },
  {
    id: 'VAR-027', category: 'Variables',
    description: '"hello world".Split(" ") yields array',
    cmd: '("hello world".Split(" ")).Count',
    assert: assert.exact('2'),
    severity: 'WARN',
  },
  {
    id: 'VAR-028', category: 'Variables',
    description: '"  hello  ".Trim()',
    cmd: '"  hello  ".Trim()',
    assert: assert.exact('hello'),
    severity: 'WARN',
  },
  {
    id: 'VAR-029', category: 'Variables',
    description: '"hello"-replace "l","r"  (PS -replace operator)',
    cmd: '"hello" -replace "l","r"',
    assert: assert.exact('herro'),
    severity: 'FAIL',
    psNote: 'Real PS: -replace uses regex, replaces ALL occurrences',
  },
  {
    id: 'VAR-030', category: 'Variables',
    description: '-like wildcard operator',
    cmd: '"PowerShell" -like "Power*"',
    assert: assert.contains('True'),
    severity: 'FAIL',
  },
  {
    id: 'VAR-031', category: 'Variables',
    description: '-match regex operator',
    cmd: '"abc123" -match "\\d+"',
    assert: assert.contains('True'),
    severity: 'FAIL',
  },
  {
    id: 'VAR-032', category: 'Variables',
    description: '$Matches is populated after -match',
    cmd: '"abc123" -match "(\\d+)"; $Matches[0]',
    assert: assert.contains('123'),
    severity: 'WARN',
    psNote: 'Real PS populates $Matches automatic variable after a -match',
  },

  // ─── Comparison operators ─────────────────────────────────────────
  {
    id: 'VAR-033', category: 'Variables',
    description: '-eq comparison',
    cmd: '1 -eq 1',
    assert: assert.contains('True'),
    severity: 'FAIL',
  },
  {
    id: 'VAR-034', category: 'Variables',
    description: '-ne comparison',
    cmd: '1 -ne 2',
    assert: assert.contains('True'),
    severity: 'FAIL',
  },
  {
    id: 'VAR-035', category: 'Variables',
    description: '-gt / -lt comparison',
    cmd: '5 -gt 3',
    assert: assert.contains('True'),
    severity: 'FAIL',
  },
  {
    id: 'VAR-036', category: 'Variables',
    description: '-and logical operator',
    cmd: '$true -and $false',
    assert: assert.contains('False'),
    severity: 'FAIL',
  },
  {
    id: 'VAR-037', category: 'Variables',
    description: '-or logical operator',
    cmd: '$true -or $false',
    assert: assert.contains('True'),
    severity: 'FAIL',
  },
  {
    id: 'VAR-038', category: 'Variables',
    description: '-not logical negation',
    cmd: '-not $false',
    assert: assert.contains('True'),
    severity: 'FAIL',
  },

  // ─── Type casting ────────────────────────────────────────────────
  {
    id: 'VAR-039', category: 'Variables',
    description: '[int] cast from string',
    cmd: '[int]"42"',
    assert: assert.exact('42'),
    severity: 'WARN',
  },
  {
    id: 'VAR-040', category: 'Variables',
    description: '[string] cast from int',
    cmd: '[string]42',
    assert: assert.exact('42'),
    severity: 'WARN',
  },
];
