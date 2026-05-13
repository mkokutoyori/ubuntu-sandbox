/**
 * Category: DHCP
 *
 * Probes dhcp enable, ip pool, gateway-list, network, dns-list,
 * excluded-ip-address, dhcp snooping, display dhcp statistics,
 * display dhcp server pool, and interface-level dhcp select commands.
 */

import type { HuaweiDiagnosticCase } from '../types';
import { assert } from '../engine';

export const dhcpChecks: HuaweiDiagnosticCase[] = [

  // ─── Global DHCP enable ──────────────────────────────────────────
  {
    id: 'DHCP-001', category: 'DHCP', device: 'router',
    description: 'dhcp enable activates DHCP service globally',
    setup: ['system-view'],
    cmd: 'dhcp enable',
    assert: assert.empty(),
    severity: 'FAIL',
    vrpNote: 'Real VRP: dhcp enable must be run before configuring pools',
  },
  {
    id: 'DHCP-002', category: 'DHCP', device: 'router',
    description: 'undo dhcp enable disables DHCP service',
    setup: ['system-view', 'dhcp enable'],
    cmd: 'undo dhcp enable',
    assert: assert.empty(),
    severity: 'WARN',
  },

  // ─── IP pool ─────────────────────────────────────────────────────
  {
    id: 'DHCP-003', category: 'DHCP', device: 'router',
    description: 'ip pool <name> creates a DHCP pool and enters pool view',
    setup: ['system-view', 'dhcp enable'],
    cmd: 'ip pool LAN_POOL',
    assert: assert.empty(),
    severity: 'FAIL',
    vrpNote: 'Real VRP: ip pool <name> enters [Huawei-ip-pool-LAN_POOL] view',
  },
  {
    id: 'DHCP-004', category: 'DHCP', device: 'router',
    description: 'network sets pool address range',
    setup: ['system-view', 'dhcp enable', 'ip pool LAN_POOL'],
    cmd: 'network 192.168.1.0 mask 255.255.255.0',
    assert: assert.empty(),
    severity: 'FAIL',
    vrpNote: 'Real VRP: network <net> mask <mask> defines the pool subnet',
  },
  {
    id: 'DHCP-005', category: 'DHCP', device: 'router',
    description: 'gateway-list sets default gateway for clients',
    setup: ['system-view', 'dhcp enable', 'ip pool LAN_POOL'],
    cmd: 'gateway-list 192.168.1.1',
    assert: assert.empty(),
    severity: 'FAIL',
    vrpNote: 'Real VRP: gateway-list <ip> pushes default-gateway option 3',
  },
  {
    id: 'DHCP-006', category: 'DHCP', device: 'router',
    description: 'dns-list sets DNS server for clients',
    setup: ['system-view', 'dhcp enable', 'ip pool LAN_POOL'],
    cmd: 'dns-list 8.8.8.8 8.8.4.4',
    assert: assert.empty(),
    severity: 'WARN',
    vrpNote: 'Real VRP: dns-list supports up to 8 DNS servers',
  },
  {
    id: 'DHCP-007', category: 'DHCP', device: 'router',
    description: 'lease sets address lease duration',
    setup: ['system-view', 'dhcp enable', 'ip pool LAN_POOL'],
    cmd: 'lease day 1 hour 0 minute 0',
    assert: assert.empty(),
    severity: 'WARN',
    vrpNote: 'Real VRP: default lease is 1 day',
  },
  {
    id: 'DHCP-008', category: 'DHCP', device: 'router',
    description: 'excluded-ip-address excludes range from pool',
    setup: ['system-view', 'dhcp enable', 'ip pool LAN_POOL', 'network 192.168.1.0 mask 255.255.255.0'],
    cmd: 'excluded-ip-address 192.168.1.1 192.168.1.10',
    assert: assert.empty(),
    severity: 'WARN',
    vrpNote: 'Real VRP: excluded-ip-address reserves IPs from being assigned',
  },
  {
    id: 'DHCP-009', category: 'DHCP', device: 'router',
    description: 'domain-name sets DNS domain suffix for clients',
    setup: ['system-view', 'dhcp enable', 'ip pool LAN_POOL'],
    cmd: 'domain-name example.local',
    assert: assert.empty(),
    severity: 'WARN',
  },
  {
    id: 'DHCP-010', category: 'DHCP', device: 'router',
    description: 'static-bind binds IP to MAC in pool',
    setup: ['system-view', 'dhcp enable', 'ip pool LAN_POOL', 'network 192.168.1.0 mask 255.255.255.0'],
    cmd: 'static-bind ip-address 192.168.1.100 mac-address 00e0-fc00-0001',
    assert: assert.empty(),
    severity: 'WARN',
    vrpNote: 'Real VRP: static-bind creates a fixed assignment within the pool',
  },

  // ─── Interface DHCP select ───────────────────────────────────────
  {
    id: 'DHCP-011', category: 'DHCP', device: 'router',
    description: 'dhcp select global enables global pool on interface',
    setup: [
      'system-view', 'dhcp enable',
      'interface GE0/0/0', 'ip address 192.168.1.1 255.255.255.0',
    ],
    cmd: 'dhcp select global',
    assert: assert.empty(),
    severity: 'FAIL',
    vrpNote: 'Real VRP: binds interface to global DHCP server pools',
  },
  {
    id: 'DHCP-012', category: 'DHCP', device: 'router',
    description: 'dhcp select interface enables interface pool',
    setup: [
      'system-view', 'dhcp enable',
      'interface GE0/0/0', 'ip address 192.168.2.1 255.255.255.0',
    ],
    cmd: 'dhcp select interface',
    assert: assert.empty(),
    severity: 'WARN',
    vrpNote: 'Real VRP: dhcp select interface creates an interface-bound pool automatically',
  },
  {
    id: 'DHCP-013', category: 'DHCP', device: 'router',
    description: 'undo dhcp select disables DHCP on interface',
    setup: [
      'system-view', 'dhcp enable',
      'interface GE0/0/0', 'ip address 192.168.1.1 255.255.255.0', 'dhcp select global',
    ],
    cmd: 'undo dhcp select global',
    assert: assert.empty(),
    severity: 'WARN',
  },

  // ─── Display commands ────────────────────────────────────────────
  {
    id: 'DHCP-014', category: 'DHCP', device: 'router',
    description: 'display dhcp server pool shows pool info',
    setup: [
      'system-view', 'dhcp enable',
      'ip pool LAN_POOL', 'network 192.168.1.0 mask 255.255.255.0', 'gateway-list 192.168.1.1', 'quit',
    ],
    cmd: 'display dhcp server pool',
    assert: assert.any(
      assert.contains('LAN_POOL'),
      assert.contains('pool'),
      assert.contains('192.168.1'),
      assert.notEmpty(),
    ),
    severity: 'WARN',
    vrpNote: 'Real VRP: shows all configured DHCP server pools',
  },
  {
    id: 'DHCP-015', category: 'DHCP', device: 'router',
    description: 'display dhcp server statistics shows allocation counts',
    setup: ['system-view', 'dhcp enable'],
    cmd: 'display dhcp server statistics',
    assert: assert.any(
      assert.contains('Pool'),
      assert.contains('Total'),
      assert.contains('Used'),
      assert.notContains('Unrecognized'),
    ),
    severity: 'WARN',
    vrpNote: 'Real VRP: shows total, used, idle address counts per pool',
  },
  {
    id: 'DHCP-016', category: 'DHCP', device: 'router',
    description: 'display dhcp server expired shows expired leases',
    setup: ['system-view', 'dhcp enable'],
    cmd: 'display dhcp server expired',
    assert: assert.notContains('Unrecognized'),
    severity: 'WARN',
  },
  {
    id: 'DHCP-017', category: 'DHCP', device: 'router',
    description: 'display dhcp server conflict shows conflicting IPs',
    setup: ['system-view', 'dhcp enable'],
    cmd: 'display dhcp server conflict',
    assert: assert.notContains('Unrecognized'),
    severity: 'WARN',
  },

  // ─── DHCP Relay ──────────────────────────────────────────────────
  {
    id: 'DHCP-018', category: 'DHCP', device: 'router',
    description: 'dhcp relay information enable activates relay',
    setup: ['system-view', 'dhcp enable', 'interface GE0/0/0'],
    cmd: 'dhcp relay information enable',
    assert: assert.empty(),
    severity: 'WARN',
    vrpNote: 'Real VRP: option 82 must be enabled for relay',
  },
  {
    id: 'DHCP-019', category: 'DHCP', device: 'router',
    description: 'dhcp relay server-ip sets relay target server',
    setup: ['system-view', 'dhcp enable', 'interface GE0/0/0', 'ip address 10.0.0.1 255.255.255.0'],
    cmd: 'dhcp relay server-ip 10.0.0.2',
    assert: assert.empty(),
    severity: 'WARN',
    vrpNote: 'Real VRP: dhcp relay server-ip <ip> points to upstream DHCP server',
  },

  // ─── DHCP Snooping (switch) ──────────────────────────────────────
  {
    id: 'DHCP-020', category: 'DHCP', device: 'switch',
    description: 'dhcp snooping enable activates snooping globally',
    setup: ['system-view'],
    cmd: 'dhcp snooping enable',
    assert: assert.empty(),
    severity: 'WARN',
    vrpNote: 'Real VRP: DHCP snooping prevents rogue DHCP servers',
  },
  {
    id: 'DHCP-021', category: 'DHCP', device: 'switch',
    description: 'dhcp snooping trusted marks uplink port as trusted',
    setup: ['system-view', 'dhcp snooping enable', 'interface GigabitEthernet0/0/1'],
    cmd: 'dhcp snooping trusted',
    assert: assert.empty(),
    severity: 'WARN',
    vrpNote: 'Real VRP: trusted ports forward DHCP offers; untrusted ports drop them',
  },
  {
    id: 'DHCP-022', category: 'DHCP', device: 'switch',
    description: 'display dhcp snooping user-bind shows binding table',
    setup: ['system-view', 'dhcp snooping enable'],
    cmd: 'display dhcp snooping user-bind',
    assert: assert.notContains('Unrecognized'),
    severity: 'WARN',
    vrpNote: 'Real VRP: shows MAC, IP, VLAN, port, lease bindings',
  },
];
