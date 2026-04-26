/**
 * Category: Network cmdlets
 *
 * Probes Get-NetIPAddress, Get-NetAdapter, Set-NetIPAddress,
 * Get-DnsClientServerAddress, Set-DnsClientServerAddress,
 * Get-NetRoute, Test-NetConnection.
 */

import type { DiagnosticCase } from '../types';
import { assert } from '../engine';

export const networkChecks: DiagnosticCase[] = [

  // ─── Get-NetAdapter ──────────────────────────────────────────────
  {
    id: 'NET-001', category: 'Network',
    description: 'Get-NetAdapter lists adapters with Name and Status',
    cmd: 'Get-NetAdapter',
    assert: assert.all(assert.contains('Name'), assert.contains('Status')),
    severity: 'FAIL',
  },
  {
    id: 'NET-002', category: 'Network',
    description: 'Get-NetAdapter shows at least one adapter',
    cmd: 'Get-NetAdapter',
    assert: assert.notEmpty(),
    severity: 'FAIL',
  },
  {
    id: 'NET-003', category: 'Network',
    description: '(Get-NetAdapter).Count returns integer',
    cmd: '(Get-NetAdapter).Count',
    assert: assert.matches(/^\d+$/),
    severity: 'WARN',
  },
  {
    id: 'NET-004', category: 'Network',
    description: 'Get-NetAdapter | Where-Object { $_.Status -eq "Up" } filters',
    cmd: 'Get-NetAdapter | Where-Object { $_.Status -eq "Up" }',
    assert: assert.notEmpty(),
    severity: 'WARN',
  },

  // ─── Get-NetIPAddress ────────────────────────────────────────────
  {
    id: 'NET-005', category: 'Network',
    description: 'Get-NetIPAddress returns IP address info',
    cmd: 'Get-NetIPAddress',
    assert: assert.contains('IPAddress'),
    severity: 'FAIL',
  },
  {
    id: 'NET-006', category: 'Network',
    description: 'Get-NetIPAddress -AddressFamily IPv4 filters to IPv4',
    cmd: 'Get-NetIPAddress -AddressFamily IPv4',
    assert: assert.contains('IPAddress'),
    severity: 'WARN',
  },
  {
    id: 'NET-007', category: 'Network',
    description: '(Get-NetIPAddress | Select -ExpandProperty IPAddress).Count',
    cmd: '(Get-NetIPAddress | Select-Object -ExpandProperty IPAddress).Count',
    assert: assert.matches(/^\d+$/),
    severity: 'WARN',
    psNote: 'Real PS: .Count on expanded scalar array',
  },
  {
    id: 'NET-008', category: 'Network',
    description: 'Get-NetIPAddress | Select-Object IPAddress,PrefixLength',
    cmd: 'Get-NetIPAddress | Select-Object IPAddress,PrefixLength',
    assert: assert.all(assert.contains('IPAddress'), assert.contains('PrefixLength')),
    severity: 'WARN',
  },

  // ─── Set-NetIPAddress ────────────────────────────────────────────
  {
    id: 'NET-009', category: 'Network',
    description: 'Set-NetIPAddress -WhatIf outputs What if message',
    cmd: 'Set-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 10.0.0.1 -PrefixLength 24 -WhatIf',
    assert: assert.contains('What if'),
    severity: 'WARN',
  },

  // ─── New / Remove-NetIPAddress ───────────────────────────────────
  {
    id: 'NET-010', category: 'Network',
    description: 'New-NetIPAddress adds an IP address',
    cmd: 'New-NetIPAddress -InterfaceAlias "Ethernet 0" -IPAddress 192.168.99.1 -PrefixLength 24',
    assert: assert.notContains('error'),
    severity: 'WARN',
    psNote: 'Real PS: adds IP to an adapter',
  },
  {
    id: 'NET-011', category: 'Network',
    description: 'Remove-NetIPAddress -WhatIf outputs What if',
    cmd: 'Remove-NetIPAddress -IPAddress 192.168.99.1 -WhatIf',
    assert: assert.contains('What if'),
    severity: 'WARN',
  },

  // ─── DNS ─────────────────────────────────────────────────────────
  {
    id: 'NET-012', category: 'Network',
    description: 'Get-DnsClientServerAddress returns DNS servers',
    cmd: 'Get-DnsClientServerAddress',
    assert: assert.contains('ServerAddresses'),
    severity: 'WARN',
  },
  {
    id: 'NET-013', category: 'Network',
    description: 'Set-DnsClientServerAddress sets DNS servers',
    cmd: 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet" -ServerAddresses 8.8.8.8,8.8.4.4',
    assert: assert.empty(),
    severity: 'WARN',
  },
  {
    id: 'NET-014', category: 'Network',
    description: '(Get-DnsClientServerAddress | Select -ExpandProperty ServerAddresses).Count',
    cmd: '(Get-DnsClientServerAddress | Select-Object -ExpandProperty ServerAddresses).Count',
    assert: assert.matches(/^\d+$/),
    severity: 'WARN',
    psNote: 'Real PS: DNS server list should be a string array with .Count',
  },

  // ─── Get-NetRoute ────────────────────────────────────────────────
  {
    id: 'NET-015', category: 'Network',
    description: 'Get-NetRoute returns routing table',
    cmd: 'Get-NetRoute',
    assert: assert.notEmpty(),
    severity: 'WARN',
  },
  {
    id: 'NET-016', category: 'Network',
    description: 'Get-NetRoute -DestinationPrefix 0.0.0.0/0 returns default route',
    cmd: 'Get-NetRoute -DestinationPrefix "0.0.0.0/0"',
    assert: assert.notEmpty(),
    severity: 'WARN',
    psNote: 'Real PS: filters to the default gateway route',
  },

  // ─── Test-NetConnection ──────────────────────────────────────────
  {
    id: 'NET-017', category: 'Network',
    description: 'Test-NetConnection returns TcpTestSucceeded or similar',
    cmd: 'Test-NetConnection -ComputerName 127.0.0.1',
    assert: assert.notEmpty(),
    severity: 'INFO',
    psNote: 'Real PS: tests TCP connectivity and returns ComputerName, RemoteAddress, etc.',
  },

  // ─── Disable/Enable-NetAdapter ───────────────────────────────────
  {
    id: 'NET-018', category: 'Network',
    description: 'Disable-NetAdapter -WhatIf outputs What if',
    cmd: 'Disable-NetAdapter -Name "Ethernet 0" -WhatIf',
    assert: assert.contains('What if'),
    severity: 'WARN',
  },
];
