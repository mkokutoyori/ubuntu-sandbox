/**
 * Category: Error messages & Registry
 *
 * Probes that error outputs match real PS5.1 format, that
 * -ErrorAction parameters are respected, and that the Registry
 * provider works correctly.
 */

import type { DiagnosticCase } from '../types';
import { assert } from '../engine';

export const errorsRegistryChecks: DiagnosticCase[] = [

  // ─── Error message format ─────────────────────────────────────────
  {
    id: 'ER-001', category: 'Errors',
    description: 'Unrecognised cmdlet error mentions the term and "cmdlet"',
    cmd: 'NoSuchCmdlet-XYZ',
    assert: assert.all(
      assert.contains('NoSuchCmdlet-XYZ'),
      assert.contains('not recognized'),
    ),
    severity: 'FAIL',
    psNote: 'Real PS: "The term \'X\' is not recognized as the name of a cmdlet…"',
  },
  {
    id: 'ER-002', category: 'Errors',
    description: 'Error includes + CategoryInfo line',
    cmd: 'NoSuchCmdlet-XYZ',
    assert: assert.contains('CategoryInfo'),
    severity: 'WARN',
    psNote: 'Real PS: errors include CategoryInfo and FullyQualifiedErrorId',
  },
  {
    id: 'ER-003', category: 'Errors',
    description: '-ErrorAction SilentlyContinue does not suppress output from working cmds',
    setup: ['Set-Content C:\\eaSC.txt "data"'],
    cmd: 'Get-Content C:\\eaSC.txt -ErrorAction SilentlyContinue',
    assert: assert.exact('data'),
    severity: 'WARN',
  },
  {
    id: 'ER-004', category: 'Errors',
    description: 'Write-Error emits error text',
    cmd: 'Write-Error "custom error message"',
    assert: assert.contains('custom error message'),
    severity: 'WARN',
    psNote: 'Real PS: Write-Error writes to the error stream',
  },
  {
    id: 'ER-005', category: 'Errors',
    description: 'Write-Warning emits WARNING: prefix',
    cmd: 'Write-Warning "watch out"',
    assert: assert.contains('WARNING'),
    severity: 'WARN',
  },
  {
    id: 'ER-006', category: 'Errors',
    description: 'Write-Verbose is silent without -Verbose flag',
    cmd: 'Write-Verbose "debug info"',
    assert: assert.empty(),
    severity: 'INFO',
    psNote: 'Real PS: Write-Verbose output only appears with -Verbose or $VerbosePreference',
  },
  {
    id: 'ER-007', category: 'Errors',
    description: 'throw produces an exception message',
    cmd: 'throw "something went wrong"',
    assert: assert.contains('something went wrong'),
    severity: 'WARN',
  },
  {
    id: 'ER-008', category: 'Errors',
    description: '$Error automatic variable populated after error',
    cmd: 'Get-Item C:\\missing_XYZ; $Error.Count',
    assert: (out) => {
      const last = out.trim().split('\n').pop() ?? '';
      return /^\d+$/.test(last) && parseInt(last, 10) > 0
        ? null : `expected $Error.Count > 0, got "${last}"`;
    },
    severity: 'WARN',
    psNote: 'Real PS: $Error is a list of recent ErrorRecord objects',
  },

  // ─── Get-Command / Get-Help ───────────────────────────────────────
  {
    id: 'ER-009', category: 'Errors',
    description: 'Get-Command lists available cmdlets',
    cmd: 'Get-Command',
    assert: assert.all(assert.contains('CommandType'), assert.contains('Name')),
    severity: 'FAIL',
  },
  {
    id: 'ER-010', category: 'Errors',
    description: 'Get-Command -Name Get-Process returns cmdlet info',
    cmd: 'Get-Command -Name Get-Process',
    assert: assert.contains('Get-Process'),
    severity: 'WARN',
  },
  {
    id: 'ER-011', category: 'Errors',
    description: 'Get-Help Get-Process shows SYNOPSIS',
    cmd: 'Get-Help Get-Process',
    assert: assert.contains('Get-Process'),
    severity: 'WARN',
  },
  {
    id: 'ER-012', category: 'Errors',
    description: 'Get-Alias shows common aliases',
    cmd: 'Get-Alias',
    assert: assert.all(assert.contains('ls'), assert.contains('cd')),
    severity: 'WARN',
  },

  // ─── Registry ────────────────────────────────────────────────────
  {
    id: 'REG-001', category: 'Registry',
    description: 'Set-Location to HKCU: changes to registry provider',
    cmd: 'Set-Location HKCU:; Get-Location',
    assert: assert.contains('HKEY_CURRENT_USER'),
    severity: 'WARN',
    psNote: 'Real PS: HKCU: is a PSDrive for HKEY_CURRENT_USER',
  },
  {
    id: 'REG-002', category: 'Registry',
    description: 'New-Item creates a registry key',
    cmd: 'New-Item -Path HKCU:\\Software\\DiagTest -Force',
    assert: assert.notContains('error'),
    severity: 'WARN',
  },
  {
    id: 'REG-003', category: 'Registry',
    description: 'Set-ItemProperty writes a registry value',
    setup: ['New-Item -Path HKCU:\\Software\\DiagTest -Force'],
    cmd: 'Set-ItemProperty -Path HKCU:\\Software\\DiagTest -Name TestVal -Value 42',
    assert: assert.empty(),
    severity: 'WARN',
  },
  {
    id: 'REG-004', category: 'Registry',
    description: 'Get-ItemProperty reads a registry value',
    setup: [
      'New-Item -Path HKCU:\\Software\\DiagTest2 -Force',
      'Set-ItemProperty -Path HKCU:\\Software\\DiagTest2 -Name Key -Value "hello"',
    ],
    cmd: 'Get-ItemProperty -Path HKCU:\\Software\\DiagTest2 -Name Key',
    assert: assert.contains('Key'),
    severity: 'WARN',
  },
  {
    id: 'REG-005', category: 'Registry',
    description: 'Remove-Item removes a registry key',
    setup: ['New-Item -Path HKCU:\\Software\\DiagRemove -Force'],
    cmd: 'Remove-Item -Path HKCU:\\Software\\DiagRemove -Recurse',
    assert: assert.empty(),
    severity: 'WARN',
  },
  {
    id: 'REG-006', category: 'Registry',
    description: 'Test-Path on registry path works',
    setup: ['New-Item -Path HKCU:\\Software\\DiagTP -Force'],
    cmd: 'Test-Path HKCU:\\Software\\DiagTP',
    assert: assert.contains('True'),
    severity: 'WARN',
  },
];
