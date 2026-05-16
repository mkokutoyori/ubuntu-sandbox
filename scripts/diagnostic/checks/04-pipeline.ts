/**
 * Category: Pipeline operators
 *
 * Probes Where-Object, Select-Object, Sort-Object, Measure-Object,
 * ForEach-Object, Group-Object, Format-Table, Format-List, Select-String,
 * Tee-Object, Out-Null, and chaining multiple stages.
 */

import type { DiagnosticCase } from '../types';
import { assert } from '../engine';

export const pipelineChecks: DiagnosticCase[] = [

  // ─── Where-Object ────────────────────────────────────────────────
  {
    id: 'PL-001', category: 'Pipeline',
    description: 'Where-Object { $_.Name -like "*svchost*" } filters processes',
    cmd: 'Get-Process | Where-Object { $_.Name -like "*svchost*" }',
    assert: assert.contains('svchost'),
    severity: 'FAIL',
  },
  {
    id: 'PL-002', category: 'Pipeline',
    description: 'Where-Object simplified syntax: ? Name -eq "System"',
    cmd: 'Get-Process | ? { $_.Name -eq "System" }',
    assert: assert.contains('System'),
    severity: 'FAIL',
  },
  {
    id: 'PL-003', category: 'Pipeline',
    description: 'Where-Object -gt numeric filter',
    cmd: 'Get-Process | Where-Object { $_.Handles -gt 200 }',
    assert: assert.notEmpty(),
    severity: 'WARN',
  },
  {
    id: 'PL-004', category: 'Pipeline',
    description: 'Where-Object returns empty when nothing matches',
    cmd: 'Get-Process | Where-Object { $_.Name -eq "NoSuchProcess_XYZ" }',
    assert: assert.empty(),
    severity: 'WARN',
    psNote: 'Real PS returns nothing (no output) when filter matches nothing',
  },

  // ─── Select-Object ───────────────────────────────────────────────
  {
    id: 'PL-005', category: 'Pipeline',
    description: 'Select-Object -Property Name,Id projects columns',
    cmd: 'Get-Process | Select-Object -Property Name,Id',
    assert: assert.all(assert.contains('Name'), assert.contains('Id')),
    severity: 'FAIL',
  },
  {
    id: 'PL-006', category: 'Pipeline',
    description: 'Select-Object -First 3 returns at most 3 objects',
    cmd: 'Get-Process | Select-Object -First 3',
    assert: (out) => {
      const dataLines = out.split('\n').filter(l => l.trim() && !l.match(/^[-=\s]+$/) && !l.match(/^\s*Name\s+/i));
      return dataLines.length <= 3 ? null : `expected ≤3 data rows, got ${dataLines.length}`;
    },
    severity: 'WARN',
  },
  {
    id: 'PL-007', category: 'Pipeline',
    description: 'Select-Object -Last 2 returns at most 2 objects',
    cmd: 'Get-Process | Select-Object -Last 2',
    assert: (out) => {
      const dataLines = out.split('\n').filter(l => l.trim() && !l.match(/^[-=\s]+$/) && !l.match(/^\s*Name\s+/i));
      return dataLines.length <= 2 ? null : `expected ≤2 data rows, got ${dataLines.length}`;
    },
    severity: 'WARN',
  },
  {
    id: 'PL-008', category: 'Pipeline',
    description: 'Select-Object -ExpandProperty Name returns bare values',
    cmd: 'Get-Process | Select-Object -ExpandProperty Name',
    assert: (out) => {
      // Should not contain table headers — just names
      return out.trim().length > 0 && !out.includes('----') ? null
        : `expected bare name list, got: ${JSON.stringify(out.slice(0, 100))}`;
    },
    severity: 'FAIL',
  },
  {
    id: 'PL-009', category: 'Pipeline',
    description: 'Select-Object -Unique deduplicates',
    cmd: '"a","a","b","b","c" | Select-Object -Unique',
    assert: (out) => {
      const lines = out.trim().split('\n').filter(Boolean);
      return lines.length <= 3 ? null : `expected ≤3 unique values, got ${lines.length}`;
    },
    severity: 'WARN',
    psNote: 'Real PS: -Unique removes duplicate values',
  },

  // ─── Sort-Object ─────────────────────────────────────────────────
  {
    id: 'PL-010', category: 'Pipeline',
    description: 'Sort-Object -Property Name sorts alphabetically',
    cmd: 'Get-Process | Sort-Object -Property Name | Select-Object -First 1',
    assert: assert.notEmpty(),
    severity: 'FAIL',
  },
  {
    id: 'PL-011', category: 'Pipeline',
    description: 'Sort-Object -Descending reverses order',
    cmd: 'Get-Process | Sort-Object -Property Name -Descending | Select-Object -First 1',
    assert: assert.notEmpty(),
    severity: 'WARN',
  },
  {
    id: 'PL-012', category: 'Pipeline',
    description: 'Sort-Object -Unique removes duplicates while sorting',
    cmd: '"c","a","b","a" | Sort-Object -Unique',
    assert: (out) => {
      const lines = out.trim().split('\n').filter(Boolean);
      return lines.length <= 3 ? null : `expected 3 unique sorted values, got ${lines.length}`;
    },
    severity: 'WARN',
  },

  // ─── Measure-Object ──────────────────────────────────────────────
  {
    id: 'PL-013', category: 'Pipeline',
    description: 'Measure-Object counts objects',
    cmd: 'Get-Process | Measure-Object',
    assert: assert.contains('Count'),
    severity: 'FAIL',
  },
  {
    id: 'PL-014', category: 'Pipeline',
    description: 'Measure-Object -Property Handles -Sum returns sum',
    cmd: 'Get-Process | Measure-Object -Property Handles -Sum',
    assert: assert.all(assert.contains('Sum'), assert.contains('Count')),
    severity: 'WARN',
  },
  {
    id: 'PL-015', category: 'Pipeline',
    description: 'Measure-Object -Property Handles -Average returns average',
    cmd: 'Get-Process | Measure-Object -Property Handles -Average',
    assert: assert.contains('Average'),
    severity: 'WARN',
  },
  {
    id: 'PL-016', category: 'Pipeline',
    description: '(Get-Process | Measure-Object).Count returns integer',
    cmd: '(Get-Process | Measure-Object).Count',
    assert: assert.matches(/^\d+$/),
    severity: 'FAIL',
  },

  // ─── ForEach-Object ──────────────────────────────────────────────
  {
    id: 'PL-017', category: 'Pipeline',
    description: 'ForEach-Object { $_.Name } extracts Name from each process',
    cmd: 'Get-Process | ForEach-Object { $_.Name }',
    assert: assert.notEmpty(),
    severity: 'FAIL',
  },
  {
    id: 'PL-018', category: 'Pipeline',
    description: '% alias works like ForEach-Object',
    cmd: 'Get-Process | % { $_.Name }',
    assert: assert.notEmpty(),
    severity: 'FAIL',
  },
  {
    id: 'PL-019', category: 'Pipeline',
    description: 'ForEach-Object -MemberName (% Name) extracts property',
    cmd: 'Get-Process | % Name',
    assert: assert.notEmpty(),
    severity: 'WARN',
    psNote: 'Real PS5+: % MemberName is equivalent to % { $_.MemberName }',
  },
  {
    id: 'PL-020', category: 'Pipeline',
    description: 'Measure-Object | % Count returns the count as scalar',
    cmd: 'Get-Process | Measure-Object | % Count',
    assert: assert.matches(/^\d+$/),
    severity: 'WARN',
  },

  // ─── Group-Object ────────────────────────────────────────────────
  {
    id: 'PL-021', category: 'Pipeline',
    description: 'Group-Object groups by property and shows Count',
    cmd: 'Get-Service | Group-Object Status',
    assert: assert.all(assert.contains('Count'), assert.contains('Name')),
    severity: 'WARN',
  },

  // ─── Select-String ───────────────────────────────────────────────
  {
    id: 'PL-022', category: 'Pipeline',
    description: 'Select-String -Pattern filters matching lines',
    setup: ['Set-Content C:\\sls.txt "foo bar\nbaz qux\nfoo again"'],
    cmd: 'Get-Content C:\\sls.txt | Select-String "foo"',
    assert: assert.all(assert.contains('foo'), assert.notContains('baz')),
    severity: 'WARN',
  },
  {
    id: 'PL-023', category: 'Pipeline',
    description: 'Select-String -NotMatch returns non-matching lines',
    setup: ['Set-Content C:\\slsNM.txt "foo\nbar\nbaz"'],
    cmd: 'Get-Content C:\\slsNM.txt | Select-String -Pattern "foo" -NotMatch',
    assert: assert.all(assert.contains('bar'), assert.notContains('foo')),
    severity: 'WARN',
    psNote: 'Real PS: -NotMatch inverts the pattern match',
  },

  // ─── Format-Table / Format-List ──────────────────────────────────
  {
    id: 'PL-024', category: 'Pipeline',
    description: 'Format-Table produces columnar output',
    cmd: 'Get-Process | Format-Table Name,Id',
    assert: assert.all(assert.contains('Name'), assert.contains('Id')),
    severity: 'WARN',
  },
  {
    id: 'PL-025', category: 'Pipeline',
    description: 'Format-List produces key : value output',
    cmd: 'Get-Process | Select-Object -First 1 | Format-List',
    assert: assert.contains(' : '),
    severity: 'WARN',
  },

  // ─── Tee-Object / Out-Null ───────────────────────────────────────
  {
    id: 'PL-026', category: 'Pipeline',
    description: 'Out-Null discards pipeline output',
    cmd: 'Get-Process | Out-Null',
    assert: assert.empty(),
    severity: 'WARN',
  },
  {
    id: 'PL-027', category: 'Pipeline',
    description: 'Tee-Object -FilePath writes to file and passes through',
    setup: [],
    cmd: '"hello" | Tee-Object -FilePath C:\\tee.txt',
    assert: assert.contains('hello'),
    severity: 'WARN',
    psNote: 'Real PS: Tee-Object writes to file AND passes object down the pipeline',
  },

  // ─── Chained pipelines ───────────────────────────────────────────
  {
    id: 'PL-028', category: 'Pipeline',
    description: '3-stage pipeline: Get-Process | Where | Select',
    cmd: 'Get-Process | Where-Object { $_.Handles -gt 0 } | Select-Object -Property Name,Handles',
    assert: assert.all(assert.contains('Name'), assert.contains('Handles')),
    severity: 'WARN',
  },
  {
    id: 'PL-029', category: 'Pipeline',
    description: '(Get-Process | Where-Object { $_.Name -like "*svc*" }).Count',
    cmd: '(Get-Process | Where-Object { $_.Name -like "*svc*" }).Count',
    assert: assert.matches(/^\d+$/),
    severity: 'WARN',
    psNote: 'Real PS: property access on pipeline result array',
  },

  // ─── .Count on collections ───────────────────────────────────────
  {
    id: 'PL-030', category: 'Pipeline',
    description: '(Get-Process).Count returns total process count',
    cmd: '(Get-Process).Count',
    assert: assert.matches(/^\d+$/),
    severity: 'WARN',
  },
];
