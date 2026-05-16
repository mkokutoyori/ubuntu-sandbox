/**
 * Category: System View & Interface Configuration
 *
 * Probes sysname, interface entry/exit, ip address, shutdown/undo shutdown,
 * description, display interface, display current-configuration interface,
 * undo ip address, LoopBack, IPv6, ARP static.
 */

import type { HuaweiDiagnosticCase } from '../types';
import { assert } from '../engine';

export const systemInterfaceChecks: HuaweiDiagnosticCase[] = [

  // ─── sysname ─────────────────────────────────────────────────────
  {
    id: 'SYS-001', category: 'System View', device: 'router',
    description: 'sysname changes the device hostname',
    setup: ['system-view'],
    cmd: 'sysname R-TEST',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'SYS-002', category: 'System View', device: 'router',
    description: 'After sysname, display current-configuration reflects new name',
    setup: ['system-view', 'sysname MY-ROUTER'],
    cmd: 'display current-configuration',
    assert: assert.contains('MY-ROUTER'),
    severity: 'FAIL',
  },
  {
    id: 'SYS-003', category: 'System View', device: 'switch',
    description: 'sysname works on switch too',
    setup: ['system-view'],
    cmd: 'sysname SW-TEST',
    assert: assert.empty(),
    severity: 'FAIL',
  },

  // ─── interface entry ──────────────────────────────────────────────
  {
    id: 'SYS-004', category: 'System View', device: 'router',
    description: 'interface GE0/0/0 enters interface view (empty output)',
    setup: ['system-view'],
    cmd: 'interface GE0/0/0',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'SYS-005', category: 'System View', device: 'router',
    description: 'int GE0/0/0 abbreviation works',
    setup: ['system-view'],
    cmd: 'int GE0/0/0',
    assert: assert.empty(),
    severity: 'WARN',
  },
  {
    id: 'SYS-006', category: 'System View', device: 'router',
    description: 'interface LoopBack 0 enters loopback view',
    setup: ['system-view'],
    cmd: 'interface LoopBack 0',
    assert: assert.empty(),
    severity: 'WARN',
    vrpNote: 'Real VRP: LoopBack is a valid virtual interface type',
  },
  {
    id: 'SYS-007', category: 'System View', device: 'router',
    description: 'quit exits interface view back to system view',
    setup: ['system-view', 'interface GE0/0/0'],
    cmd: 'quit',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'SYS-008', category: 'System View', device: 'router',
    description: 'return from interface view goes to user view',
    setup: ['system-view', 'interface GE0/0/0'],
    cmd: 'return',
    assert: assert.empty(),
    severity: 'FAIL',
  },

  // ─── ip address ──────────────────────────────────────────────────
  {
    id: 'SYS-009', category: 'System View', device: 'router',
    description: 'ip address assigns IPv4 to interface',
    setup: ['system-view', 'interface GE0/0/0'],
    cmd: 'ip address 10.0.0.1 255.255.255.0',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'SYS-010', category: 'System View', device: 'router',
    description: 'display ip interface brief shows assigned IP',
    setup: ['system-view', 'interface GE0/0/0', 'ip address 192.168.1.1 255.255.255.0', 'return'],
    cmd: 'display ip interface brief',
    assert: assert.contains('192.168.1.1'),
    severity: 'FAIL',
  },
  {
    id: 'SYS-011', category: 'System View', device: 'router',
    description: 'undo ip address removes the IP',
    setup: ['system-view', 'interface GE0/0/0', 'ip address 10.0.0.1 255.255.255.0'],
    cmd: 'undo ip address',
    assert: assert.empty(),
    severity: 'WARN',
    vrpNote: 'Real VRP: undo ip address removes the IP assignment',
  },

  // ─── shutdown / undo shutdown ─────────────────────────────────────
  {
    id: 'SYS-012', category: 'System View', device: 'router',
    description: 'shutdown brings interface down (empty output)',
    setup: ['system-view', 'interface GE0/0/0'],
    cmd: 'shutdown',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'SYS-013', category: 'System View', device: 'router',
    description: 'undo shutdown brings interface back up',
    setup: ['system-view', 'interface GE0/0/0', 'shutdown'],
    cmd: 'undo shutdown',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'SYS-014', category: 'System View', device: 'router',
    description: 'After shutdown, display ip interface brief shows DOWN state',
    setup: ['system-view', 'interface GE0/0/0', 'shutdown', 'return'],
    cmd: 'display ip interface brief',
    assert: assert.any(assert.contains('DOWN'), assert.contains('down'), assert.contains('*')),
    severity: 'WARN',
    vrpNote: 'Real VRP: shutdown interface shows *down in display ip interface brief',
  },

  // ─── description ─────────────────────────────────────────────────
  {
    id: 'SYS-015', category: 'System View', device: 'router',
    description: 'description sets interface description',
    setup: ['system-view', 'interface GE0/0/0'],
    cmd: 'description Uplink-to-Core',
    assert: assert.empty(),
    severity: 'WARN',
  },
  {
    id: 'SYS-016', category: 'System View', device: 'router',
    description: 'display current-configuration interface shows description',
    setup: [
      'system-view', 'interface GE0/0/0',
      'description To-Internet', 'return',
    ],
    cmd: 'display current-configuration interface GE0/0/0',
    assert: assert.contains('To-Internet'),
    severity: 'WARN',
  },
  {
    id: 'SYS-017', category: 'System View', device: 'router',
    description: 'undo description removes the description',
    setup: ['system-view', 'interface GE0/0/0', 'description test'],
    cmd: 'undo description',
    assert: assert.empty(),
    severity: 'WARN',
  },

  // ─── display interface ───────────────────────────────────────────
  {
    id: 'SYS-018', category: 'System View', device: 'router',
    description: 'display interface GE0/0/0 shows interface state',
    setup: ['system-view', 'interface GE0/0/0', 'ip address 10.1.1.1 255.255.255.0', 'return'],
    cmd: 'display interface GE0/0/0',
    assert: assert.all(assert.contains('GE0/0/0'), assert.contains('10.1.1.1')),
    severity: 'WARN',
  },
  {
    id: 'SYS-019', category: 'System View', device: 'router',
    description: 'display current-configuration interface shows ip address',
    setup: [
      'system-view', 'interface GE0/0/0',
      'ip address 172.16.0.1 255.255.0.0', 'return',
    ],
    cmd: 'display current-configuration interface GE0/0/0',
    assert: assert.contains('172.16.0.1'),
    severity: 'WARN',
  },

  // ─── ARP static ──────────────────────────────────────────────────
  {
    id: 'SYS-020', category: 'System View', device: 'router',
    description: 'arp static adds a static ARP entry',
    setup: ['system-view'],
    cmd: 'arp static 192.168.1.10 00e0-fc00-0001',
    assert: assert.empty(),
    severity: 'WARN',
    vrpNote: 'Real VRP: arp static <ip> <mac> [interface]',
  },
  {
    id: 'SYS-021', category: 'System View', device: 'router',
    description: 'display arp shows static entry after configuration',
    setup: ['system-view', 'arp static 10.0.0.99 0050-5600-0001'],
    cmd: 'display arp',
    assert: assert.any(assert.contains('10.0.0.99'), assert.contains('0050-5600-0001'), assert.contains('Static')),
    severity: 'WARN',
  },

  // ─── IPv6 ────────────────────────────────────────────────────────
  {
    id: 'SYS-022', category: 'System View', device: 'router',
    description: 'ipv6 enable activates IPv6 on device',
    setup: ['system-view'],
    cmd: 'ipv6',
    assert: assert.empty(),
    severity: 'WARN',
    vrpNote: 'Real VRP: ipv6 enables IPv6 forwarding globally',
  },
  {
    id: 'SYS-023', category: 'System View', device: 'router',
    description: 'ipv6 enable on interface + address assignment',
    setup: ['system-view', 'interface GE0/0/0', 'ipv6 enable'],
    cmd: 'ipv6 address 2001:db8::1/64',
    assert: assert.empty(),
    severity: 'WARN',
  },

  // ─── undo ────────────────────────────────────────────────────────
  {
    id: 'SYS-024', category: 'System View', device: 'router',
    description: 'undo sysname resets to default hostname',
    setup: ['system-view', 'sysname CUSTOM'],
    cmd: 'undo sysname',
    assert: assert.empty(),
    severity: 'WARN',
    vrpNote: 'Real VRP: undo sysname resets hostname to "Huawei"',
  },
  {
    id: 'SYS-025', category: 'System View', device: 'router',
    description: 'undo interface removes virtual interface (LoopBack)',
    setup: ['system-view', 'interface LoopBack 1'],
    cmd: 'undo interface LoopBack 1',
    assert: (out) => !out.toLowerCase().includes('unrecognized') ? null
      : `got unrecognized error: ${out.slice(0, 100)}`,
    severity: 'WARN',
    vrpNote: 'Real VRP: undo interface <name> removes virtual interfaces only',
  },
];
