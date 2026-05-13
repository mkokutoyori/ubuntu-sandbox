/**
 * Category: ACL
 *
 * Probes basic ACL (2000-2999), advanced ACL (3000-3999),
 * rule permit/deny, traffic-filter, display acl, undo acl,
 * and named ACL.
 */

import type { HuaweiDiagnosticCase } from '../types';
import { assert } from '../engine';

export const aclChecks: HuaweiDiagnosticCase[] = [

  // ─── Basic ACL (2000-2999) ───────────────────────────────────────
  {
    id: 'ACL-001', category: 'ACL', device: 'router',
    description: 'acl 2000 enters basic ACL view',
    setup: ['system-view'],
    cmd: 'acl 2000',
    assert: assert.empty(),
    severity: 'FAIL',
    vrpNote: 'Real VRP: basic ACL numbers 2000-2999, matches source IP only',
  },
  {
    id: 'ACL-002', category: 'ACL', device: 'router',
    description: 'rule permit source any in basic ACL',
    setup: ['system-view', 'acl 2000'],
    cmd: 'rule permit source any',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'ACL-003', category: 'ACL', device: 'router',
    description: 'rule deny source with host in basic ACL',
    setup: ['system-view', 'acl 2000'],
    cmd: 'rule deny source 192.168.1.0 0.0.0.255',
    assert: assert.empty(),
    severity: 'FAIL',
    vrpNote: 'Real VRP: wildcard mask (inverse mask) used in ACL rules',
  },
  {
    id: 'ACL-004', category: 'ACL', device: 'router',
    description: 'rule with explicit rule ID in basic ACL',
    setup: ['system-view', 'acl 2000'],
    cmd: 'rule 5 permit source 10.0.0.0 0.0.0.255',
    assert: assert.empty(),
    severity: 'WARN',
    vrpNote: 'Real VRP: explicit rule numbers auto-increment by 5 if not specified',
  },
  {
    id: 'ACL-005', category: 'ACL', device: 'router',
    description: 'display acl 2000 shows configured rules',
    setup: ['system-view', 'acl 2000', 'rule permit source any', 'quit'],
    cmd: 'display acl 2000',
    assert: assert.any(
      assert.contains('2000'),
      assert.contains('permit'),
      assert.contains('rule'),
      assert.notEmpty(),
    ),
    severity: 'FAIL',
    vrpNote: 'Real VRP: shows rule number, action, source, and match count',
  },
  {
    id: 'ACL-006', category: 'ACL', device: 'router',
    description: 'display acl all shows all ACLs',
    setup: ['system-view', 'acl 2000', 'rule permit source any', 'quit'],
    cmd: 'display acl all',
    assert: assert.notContains('Unrecognized'),
    severity: 'WARN',
  },
  {
    id: 'ACL-007', category: 'ACL', device: 'router',
    description: 'undo acl 2000 removes the basic ACL',
    setup: ['system-view', 'acl 2000', 'rule permit source any', 'quit'],
    cmd: 'undo acl 2000',
    assert: assert.empty(),
    severity: 'WARN',
  },

  // ─── Advanced ACL (3000-3999) ────────────────────────────────────
  {
    id: 'ACL-008', category: 'ACL', device: 'router',
    description: 'acl 3000 enters advanced ACL view',
    setup: ['system-view'],
    cmd: 'acl 3000',
    assert: assert.empty(),
    severity: 'FAIL',
    vrpNote: 'Real VRP: advanced ACL 3000-3999, matches src + dst + protocol + port',
  },
  {
    id: 'ACL-009', category: 'ACL', device: 'router',
    description: 'rule permit ip source any destination any',
    setup: ['system-view', 'acl 3000'],
    cmd: 'rule permit ip source any destination any',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'ACL-010', category: 'ACL', device: 'router',
    description: 'rule deny tcp source to destination port eq 80',
    setup: ['system-view', 'acl 3000'],
    cmd: 'rule deny tcp source 192.168.1.0 0.0.0.255 destination any destination-port eq 80',
    assert: assert.empty(),
    severity: 'WARN',
    vrpNote: 'Real VRP: destination-port eq <port> matches destination TCP/UDP port',
  },
  {
    id: 'ACL-011', category: 'ACL', device: 'router',
    description: 'rule deny udp with source-port',
    setup: ['system-view', 'acl 3000'],
    cmd: 'rule deny udp source any destination any source-port eq 53',
    assert: assert.empty(),
    severity: 'WARN',
  },
  {
    id: 'ACL-012', category: 'ACL', device: 'router',
    description: 'rule deny icmp blocks ICMP traffic',
    setup: ['system-view', 'acl 3000'],
    cmd: 'rule deny icmp source any destination any',
    assert: assert.empty(),
    severity: 'WARN',
  },
  {
    id: 'ACL-013', category: 'ACL', device: 'router',
    description: 'display acl 3000 shows advanced rules',
    setup: [
      'system-view', 'acl 3000',
      'rule permit ip source any destination any', 'quit',
    ],
    cmd: 'display acl 3000',
    assert: assert.any(
      assert.contains('3000'),
      assert.contains('permit'),
      assert.contains('ip'),
      assert.notEmpty(),
    ),
    severity: 'FAIL',
  },
  {
    id: 'ACL-014', category: 'ACL', device: 'router',
    description: 'undo rule removes a specific rule from ACL',
    setup: ['system-view', 'acl 3000', 'rule 5 permit ip source any destination any'],
    cmd: 'undo rule 5',
    assert: assert.empty(),
    severity: 'WARN',
    vrpNote: 'Real VRP: undo rule <id> removes that specific rule',
  },

  // ─── Named ACL ───────────────────────────────────────────────────
  {
    id: 'ACL-015', category: 'ACL', device: 'router',
    description: 'acl name creates a named ACL',
    setup: ['system-view'],
    cmd: 'acl name BLOCK_SSH advance',
    assert: assert.empty(),
    severity: 'WARN',
    vrpNote: 'Real VRP: named ACLs can be basic or advance (advanced)',
  },
  {
    id: 'ACL-016', category: 'ACL', device: 'router',
    description: 'Named ACL accepts rule commands',
    setup: ['system-view', 'acl name BLOCK_SSH advance'],
    cmd: 'rule deny tcp source any destination any destination-port eq 22',
    assert: assert.empty(),
    severity: 'WARN',
  },

  // ─── traffic-filter (apply ACL to interface) ─────────────────────
  {
    id: 'ACL-017', category: 'ACL', device: 'router',
    description: 'traffic-filter inbound applies ACL to interface inbound',
    setup: [
      'system-view',
      'acl 2000', 'rule deny source 10.0.0.0 0.0.0.255', 'quit',
      'interface GE0/0/0',
    ],
    cmd: 'traffic-filter inbound acl 2000',
    assert: assert.empty(),
    severity: 'FAIL',
    vrpNote: 'Real VRP: traffic-filter inbound|outbound acl <num>',
  },
  {
    id: 'ACL-018', category: 'ACL', device: 'router',
    description: 'traffic-filter outbound applies ACL to interface outbound',
    setup: [
      'system-view',
      'acl 3000', 'rule permit ip source any destination any', 'quit',
      'interface GE0/0/1',
    ],
    cmd: 'traffic-filter outbound acl 3000',
    assert: assert.empty(),
    severity: 'FAIL',
  },
  {
    id: 'ACL-019', category: 'ACL', device: 'router',
    description: 'undo traffic-filter removes ACL from interface',
    setup: [
      'system-view',
      'acl 2000', 'rule permit source any', 'quit',
      'interface GE0/0/0', 'traffic-filter inbound acl 2000',
    ],
    cmd: 'undo traffic-filter inbound acl 2000',
    assert: assert.empty(),
    severity: 'WARN',
  },

  // ─── ACL on switch (port-based filtering) ────────────────────────
  {
    id: 'ACL-020', category: 'ACL', device: 'switch',
    description: 'acl 2001 enters basic ACL on switch',
    setup: ['system-view'],
    cmd: 'acl 2001',
    assert: assert.empty(),
    severity: 'WARN',
  },
  {
    id: 'ACL-021', category: 'ACL', device: 'switch',
    description: 'traffic-filter on switch interface',
    setup: [
      'system-view',
      'acl 2001', 'rule deny source 192.168.100.0 0.0.0.255', 'quit',
      'interface GigabitEthernet0/0/1',
    ],
    cmd: 'traffic-filter inbound acl 2001',
    assert: assert.empty(),
    severity: 'WARN',
  },

  // ─── ACL reset ───────────────────────────────────────────────────
  {
    id: 'ACL-022', category: 'ACL', device: 'router',
    description: 'reset acl counter clears match statistics',
    setup: ['system-view', 'acl 2000', 'rule permit source any', 'quit'],
    cmd: 'reset acl counter 2000',
    assert: assert.notContains('Unrecognized'),
    severity: 'WARN',
    vrpNote: 'Real VRP: reset acl counter <num> clears hit counters for that ACL',
  },
];
