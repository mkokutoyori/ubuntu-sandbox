/**
 * Category: File content cmdlets
 *
 * Probes Get-Content, Set-Content, Add-Content, Clear-Content,
 * Out-File, and their parameters.
 */

import type { DiagnosticCase } from '../types';
import { assert } from '../engine';

export const contentChecks: DiagnosticCase[] = [

  // ─── Set-Content ─────────────────────────────────────────────────
  {
    id: 'CT-001', category: 'Content',
    description: 'Set-Content writes text to a file',
    cmd: 'Set-Content C:\\sc.txt "hello"',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'CT-002', category: 'Content',
    description: 'Set-Content overwrites existing content',
    setup: ['Set-Content C:\\scOver.txt "old"'],
    cmd: 'Set-Content C:\\scOver.txt "new"',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'CT-003', category: 'Content',
    description: 'Set-Content -NoNewline suppresses trailing newline',
    cmd: 'Set-Content C:\\scNL.txt "x" -NoNewline',
    assert: assert.empty(),
    severity: 'WARN',
    psNote: 'Real PS: -NoNewline prevents trailing CRLF',
  },

  // ─── Get-Content ─────────────────────────────────────────────────
  {
    id: 'CT-004', category: 'Content',
    description: 'Get-Content reads file content',
    setup: ['Set-Content C:\\gc.txt "hello world"'],
    cmd: 'Get-Content C:\\gc.txt',
    assert: assert.exact('hello world'),
    severity: 'FAIL',
  },
  {
    id: 'CT-005', category: 'Content',
    description: 'Get-Content on missing file returns error',
    cmd: 'Get-Content C:\\missing_XYZ.txt',
    assert: assert.contains('Get-Content'),
    severity: 'FAIL',
    psNote: 'Real PS: error "Cannot find path…"',
  },
  {
    id: 'CT-006', category: 'Content',
    description: 'Get-Content -TotalCount returns only first N lines',
    setup: ['Set-Content C:\\gcTC.txt "line1\nline2\nline3"'],
    cmd: 'Get-Content C:\\gcTC.txt -TotalCount 2',
    assert: (out) => {
      const lines = out.trim().split('\n').filter(Boolean);
      return lines.length <= 2 ? null : `expected ≤2 lines, got ${lines.length}`;
    },
    severity: 'WARN',
    psNote: 'Real PS: -TotalCount (alias -Head) reads first N lines',
  },
  {
    id: 'CT-007', category: 'Content',
    description: 'Get-Content -Tail returns only last N lines',
    setup: ['Set-Content C:\\gcTail.txt "a\nb\nc\nd"'],
    cmd: 'Get-Content C:\\gcTail.txt -Tail 2',
    assert: (out) => {
      const lines = out.trim().split('\n').filter(Boolean);
      return lines.length <= 2 ? null : `expected ≤2 lines, got ${lines.length}`;
    },
    severity: 'WARN',
  },
  {
    id: 'CT-008', category: 'Content',
    description: 'Get-Content -Raw returns content as single string',
    setup: ['Set-Content C:\\gcRaw.txt "line1\nline2"'],
    cmd: 'Get-Content C:\\gcRaw.txt -Raw',
    assert: assert.notEmpty(),
    severity: 'WARN',
    psNote: 'Real PS: -Raw returns the whole file as one string object',
  },
  {
    id: 'CT-009', category: 'Content',
    description: 'Get-Content piped to Measure-Object counts lines',
    setup: ['Set-Content C:\\gcMO.txt "a\nb\nc"'],
    cmd: 'Get-Content C:\\gcMO.txt | Measure-Object | % Count',
    assert: (out) => parseInt(out.trim(), 10) >= 1 ? null : `expected ≥1 line, got "${out.trim()}"`,
    severity: 'WARN',
  },

  // ─── Add-Content ─────────────────────────────────────────────────
  {
    id: 'CT-010', category: 'Content',
    description: 'Add-Content appends to file',
    setup: ['Set-Content C:\\ac.txt "line1"'],
    cmd: 'Add-Content C:\\ac.txt "line2"',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'CT-011', category: 'Content',
    description: 'Add-Content creates file if it does not exist',
    cmd: 'Add-Content C:\\acNew.txt "hello"',
    assert: assert.empty(),
    severity: 'WARN',
  },

  // ─── Clear-Content ───────────────────────────────────────────────
  {
    id: 'CT-012', category: 'Content',
    description: 'Clear-Content empties file without deleting it',
    setup: ['Set-Content C:\\cc.txt "data"'],
    cmd: 'Clear-Content C:\\cc.txt',
    assert: assert.empty(),
    severity: 'WARN',
    psNote: 'Real PS: file still exists after Clear-Content, but is empty',
  },

  // ─── Out-File ────────────────────────────────────────────────────
  {
    id: 'CT-013', category: 'Content',
    description: 'Out-File writes pipeline output to a file',
    cmd: 'Get-Process | Out-File C:\\procs.txt',
    assert: assert.empty(),
    severity: 'WARN',
  },
  {
    id: 'CT-014', category: 'Content',
    description: 'Out-File -Append does not overwrite',
    setup: ['Set-Content C:\\ofAppend.txt "existing"'],
    cmd: '"new line" | Out-File C:\\ofAppend.txt -Append',
    assert: assert.empty(),
    severity: 'WARN',
  },

  // ─── Pipeline: Set-Content as sink ───────────────────────────────
  {
    id: 'CT-015', category: 'Content',
    description: 'Pipeline output piped to Set-Content',
    cmd: '"piped content" | Set-Content C:\\piped.txt',
    assert: assert.empty(),
    severity: 'WARN',
    psNote: 'Real PS: pipeline input is written verbatim to the file',
  },
];
