/**
 * Category: User View
 *
 * Probes all commands available in <hostname> (user view):
 * display version, display current-configuration, display ip routing-table,
 * display ip interface brief, display arp, ping, tracert,
 * mode navigation (system-view, quit, return), save, reboot prompt,
 * and abbreviation matching.
 */

import type { HuaweiDiagnosticCase } from '../types';
import { assert } from '../engine';

export const userViewChecks: HuaweiDiagnosticCase[] = [

  // ─── display version ─────────────────────────────────────────────
  {
    id: 'USR-001', category: 'User View', device: 'router',
    description: 'display version shows VRP software version',
    cmd: 'display version',
    assert: assert.all(assert.contains('VRP'), assert.contains('Version')),
    severity: 'FAIL',
  },
  {
    id: 'USR-002', category: 'User View', device: 'router',
    description: 'display version shows AR2220 model (router)',
    cmd: 'display version',
    assert: assert.contains('AR2220'),
    severity: 'WARN',
  },
  {
    id: 'USR-003', category: 'User View', device: 'switch',
    description: 'display version shows S5720 model (switch)',
    cmd: 'display version',
    assert: assert.contains('S5720'),
    severity: 'WARN',
  },
  {
    id: 'USR-004', category: 'User View', device: 'router',
    description: 'dis ver abbreviation resolves to display version',
    cmd: 'dis ver',
    assert: assert.contains('VRP'),
    severity: 'WARN',
    vrpNote: 'Real VRP: any unambiguous prefix is accepted',
  },

  // ─── display ip interface brief ──────────────────────────────────
  {
    id: 'USR-005', category: 'User View', device: 'router',
    description: 'display ip interface brief shows Interface and IP columns',
    cmd: 'display ip interface brief',
    assert: assert.all(assert.contains('Interface'), assert.contains('IP Address')),
    severity: 'FAIL',
  },
  {
    id: 'USR-006', category: 'User View', device: 'router',
    description: 'display ip interface brief shows GE0/0/0 port',
    cmd: 'display ip interface brief',
    assert: assert.contains('GE0/0/0'),
    severity: 'FAIL',
  },
  {
    id: 'USR-007', category: 'User View', device: 'router',
    description: 'display ip interface brief shows unassigned as "unassigned"',
    cmd: 'display ip interface brief',
    assert: assert.contains('unassigned'),
    severity: 'WARN',
    vrpNote: 'Real VRP: shows "unassigned" for interfaces without IP',
  },

  // ─── display ip routing-table ────────────────────────────────────
  {
    id: 'USR-008', category: 'User View', device: 'router',
    description: 'display ip routing-table shows Route Flags header',
    cmd: 'display ip routing-table',
    assert: assert.any(assert.contains('Route Flags'), assert.contains('Routing')),
    severity: 'WARN',
    vrpNote: 'Real VRP: shows "Route Flags: R - relay, D - download to fib"',
  },
  {
    id: 'USR-009', category: 'User View', device: 'router',
    description: 'display ip routing-table shows Destination/Mask column',
    cmd: 'display ip routing-table',
    assert: assert.any(assert.contains('Destination'), assert.contains('Network')),
    severity: 'WARN',
  },

  // ─── display arp ─────────────────────────────────────────────────
  {
    id: 'USR-010', category: 'User View', device: 'router',
    description: 'display arp shows column headers',
    cmd: 'display arp',
    assert: assert.any(
      assert.contains('IP Address'),
      assert.contains('MAC Address'),
      assert.contains('ARP'),
    ),
    severity: 'WARN',
  },

  // ─── display current-configuration ───────────────────────────────
  {
    id: 'USR-011', category: 'User View', device: 'router',
    description: 'display current-configuration contains sysname',
    cmd: 'display current-configuration',
    assert: assert.contains('sysname'),
    severity: 'FAIL',
  },
  {
    id: 'USR-012', category: 'User View', device: 'router',
    description: 'display current-configuration shows interface blocks',
    cmd: 'display current-configuration',
    assert: assert.contains('interface'),
    severity: 'WARN',
  },
  {
    id: 'USR-013', category: 'User View', device: 'router',
    description: 'display current-configuration ends with return',
    cmd: 'display current-configuration',
    assert: assert.contains('return'),
    severity: 'WARN',
    vrpNote: 'Real VRP: config ends with the "return" keyword',
  },

  // ─── Mode navigation ─────────────────────────────────────────────
  {
    id: 'USR-014', category: 'User View', device: 'router',
    description: 'system-view enters system view without error',
    cmd: 'system-view',
    assert: assert.notContains('Error'),
    severity: 'FAIL',
    vrpNote: 'Real VRP: prints "Enter system view, return user view with return command."',
  },
  {
    id: 'USR-015', category: 'User View', device: 'router',
    description: 'sys abbreviation works for system-view',
    cmd: 'sys',
    assert: assert.empty(),
    severity: 'WARN',
  },
  {
    id: 'USR-016', category: 'User View', device: 'router',
    description: 'quit in user view is a no-op / graceful',
    cmd: 'quit',
    assert: (out) => !out.toLowerCase().includes('error') ? null
      : `expected no error, got: ${out.slice(0, 100)}`,
    severity: 'INFO',
    vrpNote: 'Real VRP: quit from user view disconnects the session',
  },
  {
    id: 'USR-017', category: 'User View', device: 'router',
    description: 'return in user view is a no-op / graceful',
    cmd: 'return',
    assert: (out) => !out.toLowerCase().includes('unrecognized') ? null
      : `expected no unrecognized error, got: ${out.slice(0, 100)}`,
    severity: 'INFO',
  },
  {
    id: 'USR-018', category: 'User View', device: 'switch',
    description: 'system-view → quit returns to user view',
    setup: ['system-view'],
    cmd: 'quit',
    assert: assert.empty(),
    severity: 'FAIL',
    vrpNote: 'Real VRP: quit from system-view exits back to user-view',
  },

  // ─── ping ────────────────────────────────────────────────────────
  {
    id: 'USR-019', category: 'User View', device: 'router',
    description: 'ping unreachable host returns timeout/failure output',
    cmd: 'ping 192.0.2.99',
    assert: assert.any(
      assert.contains('timeout'),
      assert.contains('Timeout'),
      assert.contains('unreachable'),
      assert.contains('PING'),
      assert.matches(/\d+ packet/i),
    ),
    severity: 'WARN',
  },
  {
    id: 'USR-020', category: 'User View', device: 'router',
    description: 'ping -c 3 specifies packet count',
    cmd: 'ping -c 3 192.0.2.1',
    assert: assert.any(
      assert.contains('3'),
      assert.matches(/\d+\s+packet/i),
    ),
    severity: 'WARN',
    vrpNote: 'Real VRP: -c controls packet count (default 5)',
  },
  {
    id: 'USR-021', category: 'User View', device: 'router',
    description: 'tracert unreachable host produces hop output',
    cmd: 'tracert 192.0.2.99',
    assert: assert.any(
      assert.contains('traceroute'),
      assert.contains('Traceroute'),
      assert.contains('hop'),
      assert.contains('*'),
      assert.contains('ms'),
    ),
    severity: 'WARN',
  },

  // ─── reset commands ───────────────────────────────────────────────
  {
    id: 'USR-022', category: 'User View', device: 'router',
    description: 'reset arp executes without error',
    cmd: 'reset arp',
    assert: (out) => !out.toLowerCase().includes('error') ? null
      : `unexpected error: ${out.slice(0, 100)}`,
    severity: 'WARN',
  },
  {
    id: 'USR-023', category: 'User View', device: 'router',
    description: 'reset counters executes without error',
    cmd: 'reset counters',
    assert: (out) => !out.toLowerCase().includes('error') ? null
      : `unexpected error: ${out.slice(0, 100)}`,
    severity: 'WARN',
  },

  // ─── Unknown command error format ─────────────────────────────────
  {
    id: 'USR-024', category: 'User View', device: 'router',
    description: 'Unknown command produces an error response',
    cmd: 'no-such-command-xyz',
    assert: assert.any(
      assert.contains('Unrecognized'),
      assert.contains('unrecognized'),
      assert.contains('not found'),
      assert.contains('Error'),
      assert.contains('Invalid input'),
      assert.contains('invalid input'),
      assert.contains('%'),
    ),
    severity: 'FAIL',
    vrpNote: 'Real VRP: "Error: Unrecognized command found at \'^\'position."',
  },
  {
    id: 'USR-025', category: 'User View', device: 'switch',
    description: 'Unknown command produces error on switch too',
    cmd: 'no-such-cmd-xyz',
    assert: assert.any(
      assert.contains('Unrecognized'),
      assert.contains('Error'),
    ),
    severity: 'FAIL',
  },
];
