/**
 * Category: Filesystem cmdlets
 *
 * Probes Get-ChildItem, Get-Item, New-Item, Remove-Item, Copy-Item,
 * Move-Item, Rename-Item, Test-Path and their edge cases.
 */

import type { DiagnosticCase } from '../types';
import { assert } from '../engine';

export const filesystemChecks: DiagnosticCase[] = [

  // ─── Test-Path ────────────────────────────────────────────────────
  {
    id: 'FS-001', category: 'Filesystem',
    description: 'Test-Path on existing directory returns True',
    cmd: 'Test-Path C:\\Windows',
    assert: assert.exact('True'),
    severity: 'FAIL',
  },
  {
    id: 'FS-002', category: 'Filesystem',
    description: 'Test-Path on non-existing path returns False',
    cmd: 'Test-Path C:\\DoesNotExist_XYZ',
    assert: assert.exact('False'),
    severity: 'FAIL',
  },
  {
    id: 'FS-003', category: 'Filesystem',
    description: 'Test-Path -PathType Leaf on a file returns True',
    setup: ['New-Item C:\\tpLeaf.txt -ItemType File'],
    cmd: 'Test-Path C:\\tpLeaf.txt -PathType Leaf',
    assert: assert.exact('True'),
    severity: 'WARN',
  },
  {
    id: 'FS-004', category: 'Filesystem',
    description: 'Test-Path -PathType Container on a directory returns True',
    cmd: 'Test-Path C:\\Windows -PathType Container',
    assert: assert.exact('True'),
    severity: 'WARN',
  },

  // ─── Get-ChildItem ────────────────────────────────────────────────
  {
    id: 'FS-005', category: 'Filesystem',
    description: 'Get-ChildItem on C:\\Windows lists Mode + Name columns',
    cmd: 'Get-ChildItem C:\\Windows',
    assert: assert.all(assert.contains('Mode'), assert.contains('Name')),
    severity: 'FAIL',
  },
  {
    id: 'FS-006', category: 'Filesystem',
    description: 'Get-ChildItem -Filter *.txt matches only txt files',
    setup: ['New-Item C:\\gciTest -ItemType Directory', 'Set-Content C:\\gciTest\\a.txt "a"', 'Set-Content C:\\gciTest\\b.log "b"'],
    cmd: 'Get-ChildItem C:\\gciTest -Filter *.txt',
    assert: assert.all(assert.contains('a.txt'), assert.notContains('b.log')),
    severity: 'FAIL',
  },
  {
    id: 'FS-007', category: 'Filesystem',
    description: 'Get-ChildItem -Recurse traverses subdirectories',
    setup: [
      'New-Item C:\\recDir\\sub -ItemType Directory -Force',
      'Set-Content C:\\recDir\\sub\\deep.txt "d"',
    ],
    cmd: 'Get-ChildItem C:\\recDir -Recurse',
    assert: assert.contains('deep.txt'),
    severity: 'FAIL',
  },
  {
    id: 'FS-008', category: 'Filesystem',
    description: 'Get-ChildItem -File lists only files (no directories)',
    setup: [
      'New-Item C:\\mixDir -ItemType Directory',
      'New-Item C:\\mixDir\\sub -ItemType Directory',
      'Set-Content C:\\mixDir\\f.txt "f"',
    ],
    cmd: 'Get-ChildItem C:\\mixDir -File',
    assert: assert.all(assert.contains('f.txt'), assert.notContains('sub')),
    severity: 'WARN',
  },
  {
    id: 'FS-009', category: 'Filesystem',
    description: 'Get-ChildItem -Directory lists only directories',
    setup: [
      'New-Item C:\\mixDir2 -ItemType Directory',
      'New-Item C:\\mixDir2\\subA -ItemType Directory',
      'Set-Content C:\\mixDir2\\f.txt "f"',
    ],
    cmd: 'Get-ChildItem C:\\mixDir2 -Directory',
    assert: assert.all(assert.contains('subA'), assert.notContains('f.txt')),
    severity: 'WARN',
  },
  {
    id: 'FS-010', category: 'Filesystem',
    description: 'Get-ChildItem -Hidden includes hidden items',
    cmd: 'Get-ChildItem C:\\Windows -Hidden',
    assert: assert.notEmpty(),
    severity: 'INFO',
    psNote: 'Real PS: -Hidden shows items with Hidden attribute set',
  },
  {
    id: 'FS-011', category: 'Filesystem',
    description: 'Get-ChildItem | Measure-Object counts items',
    setup: [
      'New-Item C:\\countDir -ItemType Directory',
      'Set-Content C:\\countDir\\a.txt "a"',
      'Set-Content C:\\countDir\\b.txt "b"',
    ],
    cmd: 'Get-ChildItem C:\\countDir | Measure-Object | % Count',
    assert: (out) => parseInt(out.trim(), 10) >= 2 ? null : `expected ≥2, got "${out.trim()}"`,
    severity: 'WARN',
  },

  // ─── Get-Item ────────────────────────────────────────────────────
  {
    id: 'FS-012', category: 'Filesystem',
    description: 'Get-Item returns item info with Mode and Name',
    setup: ['Set-Content C:\\giItem.txt "x"'],
    cmd: 'Get-Item C:\\giItem.txt',
    assert: assert.all(assert.contains('Mode'), assert.contains('giItem.txt')),
    severity: 'FAIL',
  },
  {
    id: 'FS-013', category: 'Filesystem',
    description: '(Get-Item path).FullName returns the absolute path',
    setup: ['Set-Content C:\\giFullName.txt "x"'],
    cmd: '(Get-Item C:\\giFullName.txt).FullName',
    assert: assert.exact('C:\\giFullName.txt'),
    severity: 'FAIL',
  },
  {
    id: 'FS-014', category: 'Filesystem',
    description: '(Get-Item dir).PSIsContainer is True for directories',
    setup: ['New-Item C:\\giDir -ItemType Directory'],
    cmd: '(Get-Item C:\\giDir).PSIsContainer',
    assert: assert.exact('True'),
    severity: 'WARN',
  },
  {
    id: 'FS-015', category: 'Filesystem',
    description: '(Get-Item file).IsReadOnly reflects readonly attribute',
    setup: ['Set-Content C:\\giRO.txt "x"'],
    cmd: '(Get-Item C:\\giRO.txt).IsReadOnly',
    assert: assert.exact('False'),
    severity: 'WARN',
  },
  {
    id: 'FS-016', category: 'Filesystem',
    description: 'Get-Item on missing path returns an error',
    cmd: 'Get-Item C:\\missing_XYZ.txt',
    assert: assert.contains('Get-Item'),
    severity: 'FAIL',
    psNote: 'Real PS: error "Cannot find path…"',
  },

  // ─── New-Item ────────────────────────────────────────────────────
  {
    id: 'FS-017', category: 'Filesystem',
    description: 'New-Item -ItemType File creates a file',
    cmd: 'New-Item C:\\newFile.txt -ItemType File',
    assert: (out) => {
      // Then confirm with Test-Path — we just need non-error output
      return out.includes('Error') || out.includes('Cannot') ? `got error: ${out.slice(0, 100)}` : null;
    },
    severity: 'FAIL',
  },
  {
    id: 'FS-018', category: 'Filesystem',
    description: 'New-Item -ItemType Directory creates a directory',
    cmd: 'New-Item C:\\newDir -ItemType Directory',
    assert: assert.notContains('Error'),
    severity: 'FAIL',
  },
  {
    id: 'FS-019', category: 'Filesystem',
    description: 'New-Item -Force does not error on existing item',
    setup: ['New-Item C:\\forceItem.txt -ItemType File'],
    cmd: 'New-Item C:\\forceItem.txt -ItemType File -Force',
    assert: assert.notContains('error'),
    severity: 'WARN',
  },
  {
    id: 'FS-020', category: 'Filesystem',
    description: 'New-Item -Value sets file content',
    cmd: 'New-Item C:\\valued.txt -ItemType File -Value "hello"',
    assert: assert.notContains('Error'),
    severity: 'WARN',
  },

  // ─── Remove-Item ─────────────────────────────────────────────────
  {
    id: 'FS-021', category: 'Filesystem',
    description: 'Remove-Item deletes a file',
    setup: ['Set-Content C:\\rmFile.txt "x"'],
    cmd: 'Remove-Item C:\\rmFile.txt',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'FS-022', category: 'Filesystem',
    description: 'Remove-Item -Recurse deletes a directory tree',
    setup: ['New-Item C:\\rmTree\\sub -ItemType Directory -Force', 'Set-Content C:\\rmTree\\sub\\f.txt "x"'],
    cmd: 'Remove-Item C:\\rmTree -Recurse',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'FS-023', category: 'Filesystem',
    description: 'Remove-Item on directory without -Recurse returns error',
    setup: ['New-Item C:\\noRecDir -ItemType Directory'],
    cmd: 'Remove-Item C:\\noRecDir',
    assert: assert.contains('is a directory'),
    severity: 'FAIL',
    psNote: 'Real PS: prompts for confirmation or errors',
  },
  {
    id: 'FS-024', category: 'Filesystem',
    description: 'Remove-Item on missing path returns an error',
    cmd: 'Remove-Item C:\\missing_XYZ.txt',
    assert: assert.contains('Remove-Item'),
    severity: 'WARN',
  },
  {
    id: 'FS-025', category: 'Filesystem',
    description: 'Remove-Item -WhatIf does not delete the file',
    setup: ['Set-Content C:\\rmWhatIf.txt "x"'],
    cmd: 'Remove-Item C:\\rmWhatIf.txt -WhatIf',
    assert: assert.contains('What if'),
    severity: 'WARN',
  },

  // ─── Copy-Item ───────────────────────────────────────────────────
  {
    id: 'FS-026', category: 'Filesystem',
    description: 'Copy-Item copies a file to new path',
    setup: ['Set-Content C:\\cpSrc.txt "original"'],
    cmd: 'Copy-Item C:\\cpSrc.txt C:\\cpDst.txt',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'FS-027', category: 'Filesystem',
    description: 'Copy-Item -WhatIf outputs What if message',
    setup: ['Set-Content C:\\cpWI.txt "x"'],
    cmd: 'Copy-Item C:\\cpWI.txt C:\\cpWIDst.txt -WhatIf',
    assert: assert.contains('What if'),
    severity: 'WARN',
  },
  {
    id: 'FS-028', category: 'Filesystem',
    description: 'Copy-Item -Recurse copies directory tree',
    setup: [
      'New-Item C:\\cpSrcDir\\sub -ItemType Directory -Force',
      'Set-Content C:\\cpSrcDir\\sub\\f.txt "x"',
    ],
    cmd: 'Copy-Item C:\\cpSrcDir C:\\cpDstDir -Recurse',
    assert: assert.empty(),
    severity: 'WARN',
  },

  // ─── Move-Item ───────────────────────────────────────────────────
  {
    id: 'FS-029', category: 'Filesystem',
    description: 'Move-Item moves file to new path',
    setup: ['Set-Content C:\\mvSrc.txt "x"'],
    cmd: 'Move-Item C:\\mvSrc.txt C:\\mvDst.txt',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'FS-030', category: 'Filesystem',
    description: 'Move-Item via pipeline: GCI file | Move-Item -Destination dest',
    setup: ['Set-Content C:\\pipeMv.txt "x"'],
    cmd: 'Get-ChildItem C:\\pipeMv.txt | Move-Item -Destination C:\\pipeMvDst.txt',
    assert: assert.empty(),
    severity: 'WARN',
  },

  // ─── Rename-Item ─────────────────────────────────────────────────
  {
    id: 'FS-031', category: 'Filesystem',
    description: 'Rename-Item renames a file',
    setup: ['Set-Content C:\\renSrc.txt "x"'],
    cmd: 'Rename-Item C:\\renSrc.txt -NewName renDst.txt',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'FS-032', category: 'Filesystem',
    description: 'Rename-Item on missing path returns error',
    cmd: 'Rename-Item C:\\missing_XYZ.txt -NewName foo.txt',
    assert: assert.contains('Rename-Item'),
    severity: 'WARN',
  },

  // ─── Set-Location / Get-Location ─────────────────────────────────
  {
    id: 'FS-033', category: 'Filesystem',
    description: 'Set-Location changes current directory',
    cmd: 'Set-Location C:\\Windows; Get-Location',
    assert: assert.contains('C:\\Windows'),
    severity: 'FAIL',
  },
  {
    id: 'FS-034', category: 'Filesystem',
    description: 'Set-Location on missing path returns error',
    cmd: 'Set-Location C:\\DoesNotExist_XYZ',
    assert: assert.contains('Set-Location'),
    severity: 'WARN',
  },
  {
    id: 'FS-035', category: 'Filesystem',
    description: 'Push-Location / Pop-Location round-trip restores CWD',
    cmd: 'Push-Location C:\\Windows; Set-Location C:\\Temp; Pop-Location; Get-Location',
    assert: assert.contains('C:\\Windows'),
    severity: 'WARN',
    psNote: 'Real PS: Pop-Location goes back to what was pushed',
  },

  // ─── Glob / wildcard ─────────────────────────────────────────────
  {
    id: 'FS-036', category: 'Filesystem',
    description: 'Get-ChildItem with wildcard *.txt',
    setup: [
      'New-Item C:\\wc -ItemType Directory',
      'Set-Content C:\\wc\\a.txt "a"',
      'Set-Content C:\\wc\\b.log "b"',
    ],
    cmd: 'Get-ChildItem C:\\wc\\*.txt',
    assert: assert.all(assert.contains('a.txt'), assert.notContains('b.log')),
    severity: 'FAIL',
  },
  {
    id: 'FS-037', category: 'Filesystem',
    description: 'Get-ChildItem -Include *.txt -Recurse',
    setup: [
      'New-Item C:\\incDir\\sub -ItemType Directory -Force',
      'Set-Content C:\\incDir\\sub\\x.txt "x"',
      'Set-Content C:\\incDir\\sub\\y.log "y"',
    ],
    cmd: 'Get-ChildItem C:\\incDir -Include *.txt -Recurse',
    assert: assert.all(assert.contains('x.txt'), assert.notContains('y.log')),
    severity: 'WARN',
  },
  {
    id: 'FS-038', category: 'Filesystem',
    description: 'Get-ChildItem -Exclude *.log',
    setup: [
      'New-Item C:\\exDir -ItemType Directory',
      'Set-Content C:\\exDir\\a.txt "a"',
      'Set-Content C:\\exDir\\b.log "b"',
    ],
    cmd: 'Get-ChildItem C:\\exDir -Exclude *.log',
    assert: assert.all(assert.contains('a.txt'), assert.notContains('b.log')),
    severity: 'WARN',
  },
];
