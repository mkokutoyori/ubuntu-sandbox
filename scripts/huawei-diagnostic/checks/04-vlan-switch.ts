/**
 * Category: VLAN & Switch (HuaweiSwitch only)
 *
 * Probes vlan creation, naming, port link-type access/trunk,
 * port default vlan, port trunk allow-pass vlan, port trunk pvid vlan,
 * display vlan, display mac-address, display interface brief,
 * mac-address aging-time, undo vlan, and Huawei VLAN deletion behaviour.
 */

import type { HuaweiDiagnosticCase } from '../types';
import { assert } from '../engine';

export const vlanSwitchChecks: HuaweiDiagnosticCase[] = [

  // ─── VLAN creation ───────────────────────────────────────────────
  {
    id: 'VL-001', category: 'VLAN & Switch', device: 'switch',
    description: 'vlan 10 enters VLAN configuration view',
    setup: ['system-view'],
    cmd: 'vlan 10',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'VL-002', category: 'VLAN & Switch', device: 'switch',
    description: 'VLAN name can be set inside vlan view',
    setup: ['system-view', 'vlan 10'],
    cmd: 'name Sales',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'VL-003', category: 'VLAN & Switch', device: 'switch',
    description: 'display vlan shows created VLAN',
    setup: ['system-view', 'vlan 10', 'name Marketing', 'quit'],
    cmd: 'display vlan',
    assert: assert.contains('10'),
    severity: 'FAIL',
  },
  {
    id: 'VL-004', category: 'VLAN & Switch', device: 'switch',
    description: 'display vlan shows VLAN name',
    setup: ['system-view', 'vlan 20', 'name Finance', 'quit'],
    cmd: 'display vlan',
    assert: assert.contains('Finance'),
    severity: 'WARN',
  },
  {
    id: 'VL-005', category: 'VLAN & Switch', device: 'switch',
    description: 'display vlan shows VLAN 1 by default',
    cmd: 'display vlan',
    assert: assert.contains('1'),
    severity: 'FAIL',
    vrpNote: 'Real VRP: VLAN 1 always exists as the default VLAN',
  },
  {
    id: 'VL-006', category: 'VLAN & Switch', device: 'switch',
    description: 'vlan batch creates multiple VLANs at once',
    setup: ['system-view'],
    cmd: 'vlan batch 30 40 50',
    assert: assert.empty(),
    severity: 'WARN',
    vrpNote: 'Real VRP: vlan batch creates multiple VLANs in one command',
  },
  {
    id: 'VL-007', category: 'VLAN & Switch', device: 'switch',
    description: 'undo vlan removes a VLAN',
    setup: ['system-view', 'vlan 99', 'quit'],
    cmd: 'undo vlan 99',
    assert: assert.empty(),
    severity: 'WARN',
  },
  {
    id: 'VL-008', category: 'VLAN & Switch', device: 'switch',
    description: 'After undo vlan, VLAN no longer appears in display vlan',
    setup: ['system-view', 'vlan 55', 'quit', 'undo vlan 55'],
    cmd: 'display vlan',
    assert: assert.notContains('55'),
    severity: 'WARN',
    vrpNote: 'Real VRP Huawei: deleted VLAN ports are moved back to VLAN 1, not suspended',
  },
  {
    id: 'VL-009', category: 'VLAN & Switch', device: 'switch',
    description: 'quit exits VLAN view back to system view',
    setup: ['system-view', 'vlan 10'],
    cmd: 'quit',
    assert: assert.empty(),
    severity: 'FAIL',
  },

  // ─── Port link-type ──────────────────────────────────────────────
  {
    id: 'VL-010', category: 'VLAN & Switch', device: 'switch',
    description: 'port link-type access sets port to access mode',
    setup: ['system-view', 'interface GigabitEthernet0/0/1'],
    cmd: 'port link-type access',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'VL-011', category: 'VLAN & Switch', device: 'switch',
    description: 'port link-type trunk sets port to trunk mode',
    setup: ['system-view', 'interface GigabitEthernet0/0/2'],
    cmd: 'port link-type trunk',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'VL-012', category: 'VLAN & Switch', device: 'switch',
    description: 'port default vlan assigns access VLAN',
    setup: [
      'system-view', 'vlan 10', 'quit',
      'interface GigabitEthernet0/0/3', 'port link-type access',
    ],
    cmd: 'port default vlan 10',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'VL-013', category: 'VLAN & Switch', device: 'switch',
    description: 'port trunk allow-pass vlan sets trunk allowed VLANs',
    setup: [
      'system-view', 'vlan batch 10 20',
      'interface GigabitEthernet0/0/4', 'port link-type trunk',
    ],
    cmd: 'port trunk allow-pass vlan 10 20',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'VL-014', category: 'VLAN & Switch', device: 'switch',
    description: 'port trunk pvid vlan sets native VLAN on trunk',
    setup: [
      'system-view', 'vlan 10', 'quit',
      'interface GigabitEthernet0/0/5', 'port link-type trunk',
    ],
    cmd: 'port trunk pvid vlan 10',
    assert: assert.empty(),
    severity: 'WARN',
    vrpNote: 'Real VRP: pvid sets the trunk native VLAN (untagged VLAN)',
  },

  // ─── display interface brief (switch) ────────────────────────────
  {
    id: 'VL-015', category: 'VLAN & Switch', device: 'switch',
    description: 'display interface brief shows GigabitEthernet ports',
    cmd: 'display interface brief',
    assert: assert.any(
      assert.contains('GigabitEthernet'),
      assert.contains('GE'),
      assert.contains('Interface'),
    ),
    severity: 'FAIL',
  },
  {
    id: 'VL-016', category: 'VLAN & Switch', device: 'switch',
    description: 'display interface GigabitEthernet0/0/0 shows port details',
    cmd: 'display interface GigabitEthernet0/0/0',
    assert: assert.any(
      assert.contains('GigabitEthernet'),
      assert.contains('GE'),
    ),
    severity: 'WARN',
  },
  {
    id: 'VL-017', category: 'VLAN & Switch', device: 'switch',
    description: 'display current-configuration shows vlan blocks',
    setup: ['system-view', 'vlan 10', 'name LAN', 'quit'],
    cmd: 'display current-configuration',
    assert: assert.contains('vlan'),
    severity: 'WARN',
  },
  {
    id: 'VL-018', category: 'VLAN & Switch', device: 'switch',
    description: 'display current-configuration interface shows port link-type',
    setup: [
      'system-view',
      'interface GigabitEthernet0/0/1', 'port link-type access', 'quit',
    ],
    cmd: 'display current-configuration interface GigabitEthernet0/0/1',
    assert: assert.any(assert.contains('access'), assert.contains('link-type')),
    severity: 'WARN',
  },

  // ─── MAC address table ───────────────────────────────────────────
  {
    id: 'VL-019', category: 'VLAN & Switch', device: 'switch',
    description: 'display mac-address shows MAC table header',
    cmd: 'display mac-address',
    assert: assert.any(
      assert.contains('MAC'),
      assert.contains('VLAN'),
      assert.contains('Total'),
    ),
    severity: 'WARN',
    vrpNote: 'Real VRP: shows MAC address, VLAN, port, type columns',
  },
  {
    id: 'VL-020', category: 'VLAN & Switch', device: 'switch',
    description: 'display mac-address aging-time shows aging timer',
    cmd: 'display mac-address aging-time',
    assert: assert.any(
      assert.contains('aging'),
      assert.matches(/\d+/),
    ),
    severity: 'WARN',
    vrpNote: 'Real VRP: default aging time is 300 seconds',
  },
  {
    id: 'VL-021', category: 'VLAN & Switch', device: 'switch',
    description: 'mac-address aging-time sets aging timer',
    setup: ['system-view'],
    cmd: 'mac-address aging-time 600',
    assert: assert.empty(),
    severity: 'WARN',
    vrpNote: 'Real VRP: range 0 or 10–1000000 seconds',
  },
  {
    id: 'VL-022', category: 'VLAN & Switch', device: 'switch',
    description: 'shutdown on switch interface works',
    setup: ['system-view', 'interface GigabitEthernet0/0/6'],
    cmd: 'shutdown',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'VL-023', category: 'VLAN & Switch', device: 'switch',
    description: 'undo shutdown brings switch interface back up',
    setup: ['system-view', 'interface GigabitEthernet0/0/6', 'shutdown'],
    cmd: 'undo shutdown',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'VL-024', category: 'VLAN & Switch', device: 'switch',
    description: 'Huawei VLAN deletion: port moves to VLAN 1, not suspended',
    setup: [
      'system-view', 'vlan 77', 'quit',
      'interface GigabitEthernet0/0/7',
      'port link-type access', 'port default vlan 77', 'quit',
      'undo vlan 77',
    ],
    cmd: 'display vlan',
    assert: assert.notContains('77'),
    severity: 'WARN',
    vrpNote: 'Huawei-specific: port falls back to VLAN 1 on VLAN deletion',
  },
];
