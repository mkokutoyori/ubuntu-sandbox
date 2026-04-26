/**
 * Category: Process & Service cmdlets
 *
 * Probes Get-Process, Stop-Process, Get-Service, Start-Service,
 * Stop-Service, Restart-Service, Set-Service.
 */

import type { DiagnosticCase } from '../types';
import { assert } from '../engine';

export const processServiceChecks: DiagnosticCase[] = [

  // ─── Get-Process ─────────────────────────────────────────────────
  {
    id: 'PS-001', category: 'Process',
    description: 'Get-Process lists processes with correct columns',
    cmd: 'Get-Process',
    assert: assert.all(
      assert.contains('Handles'),
      assert.contains('NPM(K)'),
      assert.contains('PM(K)'),
      assert.contains('WS(K)'),
      assert.contains('CPU(s)'),
      assert.contains('Id'),
    ),
    severity: 'FAIL',
  },
  {
    id: 'PS-002', category: 'Process',
    description: 'Get-Process -Name filters by name',
    cmd: 'Get-Process -Name svchost',
    assert: assert.contains('svchost'),
    severity: 'FAIL',
  },
  {
    id: 'PS-003', category: 'Process',
    description: 'Get-Process -Name unknown returns error',
    cmd: 'Get-Process -Name NoSuchProcess_XYZ',
    assert: assert.contains('Cannot find a process'),
    severity: 'FAIL',
  },
  {
    id: 'PS-004', category: 'Process',
    description: 'Get-Process -Id 4 returns System process',
    cmd: 'Get-Process -Id 4',
    assert: assert.contains('System'),
    severity: 'WARN',
  },
  {
    id: 'PS-005', category: 'Process',
    description: 'Get-Process -IncludeUserName shows UserName column',
    cmd: 'Get-Process -IncludeUserName',
    assert: assert.contains('UserName'),
    severity: 'WARN',
  },
  {
    id: 'PS-006', category: 'Process',
    description: 'Get-Process -Module returns module table',
    cmd: 'Get-Process | Select-Object -First 1 | ForEach-Object { Get-Process -Id $_.Id -Module }',
    assert: assert.contains('ModuleName'),
    severity: 'WARN',
  },
  {
    id: 'PS-007', category: 'Process',
    description: '(Get-Process -Name svchost).Count returns integer',
    cmd: '(Get-Process -Name svchost).Count',
    assert: assert.matches(/^\d+$/),
    severity: 'WARN',
  },
  {
    id: 'PS-008', category: 'Process',
    description: 'Get-Process | Sort-Object CPU -Descending works',
    cmd: 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 3',
    assert: assert.notEmpty(),
    severity: 'WARN',
  },

  // ─── Stop-Process ────────────────────────────────────────────────
  {
    id: 'PS-009', category: 'Process',
    description: 'Stop-Process -Name unknown returns error',
    cmd: 'Stop-Process -Name NoSuchProcess_XYZ',
    assert: assert.contains('Cannot find a process'),
    severity: 'FAIL',
  },
  {
    id: 'PS-010', category: 'Process',
    description: 'Stop-Process -WhatIf outputs What if message',
    cmd: 'Stop-Process -Name svchost -WhatIf',
    assert: assert.contains('What if'),
    severity: 'WARN',
  },
  {
    id: 'PS-011', category: 'Process',
    description: 'Stop-Process on critical process is blocked',
    cmd: 'Stop-Process -Id 4',
    assert: assert.contains('critical'),
    severity: 'WARN',
    psNote: 'Real PS: killing System (PID 4) is blocked by OS',
  },
  {
    id: 'PS-012', category: 'Process',
    description: 'Stop-Process removes process from Get-Process',
    setup: [],
    cmd: 'Stop-Process -Name taskhostw; Get-Process -Name taskhostw',
    assert: assert.contains('Cannot find a process'),
    severity: 'WARN',
  },

  // ─── Get-Service ─────────────────────────────────────────────────
  {
    id: 'PS-013', category: 'Service',
    description: 'Get-Service lists services with Status and Name',
    cmd: 'Get-Service',
    assert: assert.all(assert.contains('Status'), assert.contains('Name')),
    severity: 'FAIL',
  },
  {
    id: 'PS-014', category: 'Service',
    description: 'Get-Service -Name filters by name',
    cmd: 'Get-Service -Name Themes',
    assert: assert.contains('Themes'),
    severity: 'FAIL',
  },
  {
    id: 'PS-015', category: 'Service',
    description: 'Get-Service -Name unknown returns error',
    cmd: 'Get-Service -Name NoSuchService_XYZ',
    assert: assert.contains('Cannot find any service'),
    severity: 'FAIL',
  },
  {
    id: 'PS-016', category: 'Service',
    description: 'Get-Service | Where-Object { $_.Status -eq "Running" } filters',
    cmd: 'Get-Service | Where-Object { $_.Status -eq "Running" }',
    assert: assert.contains('Running'),
    severity: 'WARN',
  },
  {
    id: 'PS-017', category: 'Service',
    description: '(Get-Service).Count returns integer',
    cmd: '(Get-Service).Count',
    assert: assert.matches(/^\d+$/),
    severity: 'WARN',
  },

  // ─── Start / Stop / Restart-Service ──────────────────────────────
  {
    id: 'PS-018', category: 'Service',
    description: 'Stop-Service -WhatIf outputs What if message',
    cmd: 'Stop-Service -Name Themes -WhatIf',
    assert: assert.contains('What if'),
    severity: 'WARN',
  },
  {
    id: 'PS-019', category: 'Service',
    description: 'Restart-Service -WhatIf outputs What if message',
    cmd: 'Restart-Service -Name Themes -WhatIf',
    assert: assert.contains('What if'),
    severity: 'WARN',
  },
  {
    id: 'PS-020', category: 'Service',
    description: 'Get-Service | Stop-Service -WhatIf uses pipeline input',
    cmd: 'Get-Service -Name Themes | Stop-Service -WhatIf',
    assert: assert.contains('What if'),
    severity: 'WARN',
  },
  {
    id: 'PS-021', category: 'Service',
    description: 'Set-Service changes StartupType',
    cmd: 'Set-Service -Name Themes -StartupType Disabled',
    assert: assert.empty(),
    severity: 'WARN',
    psNote: 'Real PS: Set-Service changes service configuration',
  },
];
