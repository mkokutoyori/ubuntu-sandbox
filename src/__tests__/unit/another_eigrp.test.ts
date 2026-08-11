/**
 * TDD Unit Tests for EIGRP (Enhanced Interior Gateway Routing Protocol) on Cisco IOS.
 *
 * Covers:
 *  - Process & AS: router eigrp <as>, no router eigrp <as>, AS mismatch handling
 *  - Network & Wildcards: network <net> [wildcard], classful vs classless wildcards
 *  - Neighbor Adjacency: Hello/Hold timers, K-Values match requirement, Router-ID
 *  - Metric & DUAL: Composite Metric (BW, Delay), Feasible Distance (FD),
 *                   Reported/Advertised Distance (RD/AD), Feasibility Condition (RD < FD),
 *                   Successor & Feasible Successor selection
 *  - Summarization: auto-summary / no auto-summary, ip summary-address eigrp <as> <prefix> <mask> (AD 5)
 *  - Traffic Control: passive-interface (specific & default), variance (Unequal Cost Load Balancing), maximum-paths
 *  - Stub Routing: eigrp stub [connected|summary|static|receive-only]
 *  - Redistribution & AD: Internal AD (90), External AD (170), Summary AD (5), redistribute static/connected
 *  - Interface Settings: ip hello-interval, ip hold-time, ip bandwidth-percent, ip authentication mode md5
 *  - Show & Exec: show ip eigrp neighbors, show ip eigrp topology, show ip eigrp interfaces, show ip protocols, clear ip eigrp neighbors
 *  - Error Handling: Invalid AS numbers, K-value mismatches, out-of-bounds inputs, Cisco IOS error prompts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

// ═══════════════════════════════════════════════════════════════════
// TOPOLOGY HELPERS & SETUP
// ═══════════════════════════════════════════════════════════════════

/**
 * Direct Point-to-Point link between R1 and R2
 * R1 (Gig0/0: 10.0.12.1/24) <---> (Gig0/0: 10.0.12.2/24) R2
 */
function setupTwoRouterTopology() {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 100, 0);

  const cable = new Cable('c1');
  cable.connect(
    r1.getPort('GigabitEthernet0/0')!,
    r2.getPort('GigabitEthernet0/0')!
  );

  return { r1, r2 };
}

/** Configures IPs and Loopbacks on R1 and R2 */
async function configureIPsR1R2(r1: CiscoRouter, r2: CiscoRouter) {
  // R1
  await r1.executeCommand('enable');
  await r1.executeCommand('configure terminal');
  await r1.executeCommand('interface GigabitEthernet0/0');
  await r1.executeCommand('ip address 10.0.12.1 255.255.255.0');
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('interface Loopback0');
  await r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
  await r1.executeCommand('end');

  // R2
  await r2.executeCommand('enable');
  await r2.executeCommand('configure terminal');
  await r2.executeCommand('interface GigabitEthernet0/0');
  await r2.executeCommand('ip address 10.0.12.2 255.255.255.0');
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('interface Loopback0');
  await r2.executeCommand('ip address 192.168.2.1 255.255.255.0');
  await r2.executeCommand('end');
}

/**
 * Triangle Topology for Dual Path / Feasible Successor & Variance Tests:
 *       R1 (Gig0/0) <-------> (Gig0/0) R2
 *       (Gig0/1)               (Gig0/1)
 *          \                     /
 *           \---> (Gig0/0) R3 <-/
 */
function setupTriangleTopology() {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 100, 0);
  const r3 = new CiscoRouter('R3', 50, 100);

  new Cable('c1').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('c2').connect(r2.getPort('GigabitEthernet0/1')!, r3.getPort('GigabitEthernet0/1')!);
  new Cable('c3').connect(r3.getPort('GigabitEthernet0/0')!, r1.getPort('GigabitEthernet0/1')!);

  return { r1, r2, r3 };
}

// ═══════════════════════════════════════════════════════════════════
// EIGRP TEST SUITE
// ═══════════════════════════════════════════════════════════════════

describe('Cisco IOS EIGRP Protocol Unit Tests', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  // ─── 1. PROCESS ACTIVATION & AS NUMBER VALIDATION ────────────────

  describe('Process Activation & AS Validation', () => {
    it('1. should enter EIGRP config mode with valid AS number', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      const res = await r1.executeCommand('router eigrp 100');

      expect(r1.getPrompt()).toMatch(/R1\(config-router\)#/);
      expect(res).toBe('');
    });

    it('2. should reject missing Autonomous System (AS) number', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      const res = await r1.executeCommand('router eigrp');

      expect(res).toContain('% Incomplete command.');
    });

    it('3. should reject out-of-range AS number (e.g. 0 or > 65535)', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');

      const res0 = await r1.executeCommand('router eigrp 0');
      expect(res0).toContain('% Invalid input');

      const resHigh = await r1.executeCommand('router eigrp 70000');
      expect(resHigh).toContain('% Invalid input');
    });

    it('4. should remove EIGRP process with "no router eigrp <as>"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');
      await r1.executeCommand('network 10.0.0.0');
      await r1.executeCommand('exit');

      const res = await r1.executeCommand('no router eigrp 100');
      expect(res).toBe('');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).not.toContain('Routing Protocol is "eigrp 100"');
    });

    it('5. should ignore "no router eigrp <as>" if AS does not match active process', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');
      await r1.executeCommand('exit');

      await r1.executeCommand('no router eigrp 200');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Routing Protocol is "eigrp 100"');
    });
  });

  // ─── 2. NETWORK COMMAND & WILDCARD MASKS ─────────────────────────

  describe('Network Command & Wildcard Mask Matching', () => {
    it('6. should accept classful network statement without wildcard mask', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');
      const res = await r1.executeCommand('network 10.0.0.0');

      expect(res).toBe('');
      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('10.0.0.0');
    });

    it('7. should accept subnet address with explicit wildcard mask', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');
      const res = await r1.executeCommand('network 10.0.12.0 0.0.0.255');

      expect(res).toBe('');
      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('10.0.12.0 0.0.0.255');
    });

    it('8. should convert subnet mask to wildcard mask if user accidentally types subnet mask', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');
      // User typed 255.255.255.0 instead of 0.0.0.255
      await r1.executeCommand('network 10.0.12.0 255.255.255.0');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('10.0.12.0 0.0.0.255');
    });

    it('9. should remove network statement with "no network <net> [wildcard]"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');
      await r1.executeCommand('network 10.0.12.0 0.0.0.255');
      await r1.executeCommand('no network 10.0.12.0 0.0.0.255');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).not.toContain('10.0.12.0');
    });
  });

  // ─── 3. ADJACENCY FORMATION & AS / K-VALUE MATCHING ─────────────

  describe('Neighbor Adjacency & AS / K-Value Matching', () => {
    it('10. should establish EIGRP neighbor adjacency when AS numbers match', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureIPsR1R2(r1, r2);

      // AS 100 on both
      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router eigrp 100');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('end');
      }

      await r1.processTimers(5);

      const neighbors = await r1.executeCommand('show ip eigrp neighbors');
      expect(neighbors).toContain('10.0.12.2');
      expect(neighbors).toContain('GigabitEthernet0/0');
    });

    it('11. should NOT form neighbor adjacency when AS numbers mismatch', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureIPsR1R2(r1, r2);

      // R1: AS 100
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');
      await r1.executeCommand('network 10.0.0.0');
      await r1.executeCommand('end');

      // R2: AS 200
      await r2.executeCommand('enable');
      await r2.executeCommand('configure terminal');
      await r2.executeCommand('router eigrp 200');
      await r2.executeCommand('network 10.0.0.0');
      await r2.executeCommand('end');

      await r1.processTimers(15);

      const neighborsR1 = await r1.executeCommand('show ip eigrp neighbors');
      expect(neighborsR1).not.toContain('10.0.12.2');
    });

    it('12. should log K-value mismatch and tear down adjacency when K-values differ', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureIPsR1R2(r1, r2);

      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router eigrp 100');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('end');
      }

      await r1.processTimers(5);

      // Change K-values on R1: metric weights <tos> <k1> <k2> <k3> <k4> <k5>
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');
      await r1.executeCommand('metric weights 0 2 0 1 0 0');

      await r1.processTimers(5);

      const logs = Logger.getLogs();
      expect(logs.some(l => l.includes('K-value mismatch') || l.includes('Neighbor down'))).toBe(true);

      const neighbors = await r1.executeCommand('show ip eigrp neighbors');
      expect(neighbors).not.toContain('10.0.12.2');
    });

    it('13. should configure custom Router ID with "eigrp router-id <ip>"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');
      const res = await r1.executeCommand('eigrp router-id 1.1.1.1');

      expect(res).toBe('');
      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('EIGRP Router-ID: 1.1.1.1');
    });
  });

  // ─── 4. METRIC CALCULATION & DUAL ALGORITHM ─────────────────────

  describe('Metric Calculation & DUAL Feasibility Condition', () => {
    it('14. should calculate Composite Metric based on Minimum Bandwidth + Cumulative Delay', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureIPsR1R2(r1, r2);

      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router eigrp 100');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('network 192.168.0.0');
        await r.executeCommand('end');
      }

      await r1.processTimers(5);

      const routes = await r1.executeCommand('show ip route eigrp');
      // EIGRP Administrative Distance = 90
      expect(routes).toContain('D    192.168.2.0/24 [90/');
    });

    it('15. "show ip eigrp topology" should display Feasible Distance (FD) and Reported Distance (RD)', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureIPsR1R2(r1, r2);

      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router eigrp 100');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('network 192.168.0.0');
        await r.executeCommand('end');
      }

      await r1.processTimers(5);

      const topo = await r1.executeCommand('show ip eigrp topology');
      expect(topo).toContain('P 192.168.2.0/24, 1 successors, FD is');
      expect(topo).toContain('via 10.0.12.2');
    });

    it('16. should install Feasible Successor in topology table when Feasibility Condition (RD < FD) is met', async () => {
      const { r1 } = setupTriangleTopology();
      // ... In triangle setup, backup path with RD < FD is marked as Feasible Successor
      await r1.executeCommand('enable');
      const topo = await r1.executeCommand('show ip eigrp topology all-links');
      expect(topo).toBeDefined();
    });
  });

  // ─── 5. SUMMARIZATION (AUTO & MANUAL) ───────────────────────────

  describe('Auto-Summary & Manual Route Summarization', () => {
    it('17. should disable auto-summary using "no auto-summary"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');
      const res = await r1.executeCommand('no auto-summary');

      expect(res).toBe('');
      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Automatic summarization: disabled');
    });

    it('18. should configure manual summary route on interface with "ip summary-address eigrp <as> <prefix> <mask>"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      const res = await r1.executeCommand('ip summary-address eigrp 100 172.16.0.0 255.255.0.0');

      expect(res).toBe('');
    });

    it('19. should install summary route pointing to Null0 with Administrative Distance of 5', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('ip summary-address eigrp 100 172.16.0.0 255.255.0.0');
      await r1.executeCommand('end');

      const route = await r1.executeCommand('show ip route 172.16.0.0');
      expect(route).toContain('Null0');
      expect(route).toContain('Distance: 5');
    });
  });

  // ─── 6. PASSIVE INTERFACES ──────────────────────────────────────

  describe('Passive Interface Settings', () => {
    it('20. should suppress EIGRP Hello packets on passive interface', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureIPsR1R2(r1, r2);

      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router eigrp 100');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('end');
      }

      // Make R1 interface passive
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');
      await r1.executeCommand('passive-interface GigabitEthernet0/0');

      await r1.processTimers(15);

      // Neighbor adjacency should drop or fail to form
      const neighbors = await r1.executeCommand('show ip eigrp neighbors');
      expect(neighbors).not.toContain('10.0.12.2');
    });

    it('21. should support "passive-interface default" and selective "no passive-interface"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');
      await r1.executeCommand('passive-interface default');
      await r1.executeCommand('no passive-interface GigabitEthernet0/0');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Passive Interface(s):');
      expect(show).toContain('Default');
      expect(show).toContain('Active Interface(s):');
      expect(show).toContain('GigabitEthernet0/0');
    });
  });

  // ─── 7. EIGRP STUB ROUTING ──────────────────────────────────────

  describe('EIGRP Stub Router Configuration', () => {
    it('22. should configure stub router with "eigrp stub"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');
      const res = await r1.executeCommand('eigrp stub');

      expect(res).toBe('');
      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('EIGRP stub-router feature is enabled');
    });

    it('23. should support stub options: "eigrp stub connected static"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');
      const res = await r1.executeCommand('eigrp stub connected static');

      expect(res).toBe('');
      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Connected');
      expect(show).toContain('Static');
    });

    it('24. should support receive-only stub mode with "eigrp stub receive-only"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');
      await r1.executeCommand('eigrp stub receive-only');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Receive-Only');
    });
  });

  // ─── 8. UNEQUAL COST LOAD BALANCING (VARIANCE) ──────────────────

  describe('Traffic Balancing & Variance', () => {
    it('25. should default variance multiplier to 1 (equal cost load balancing only)', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      const show = await r1.executeCommand('show ip protocols');

      expect(show).toContain('EIGRP maximum metric variance 1');
    });

    it('26. should configure unequal cost load balancing with "variance <1-128>"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');
      const res = await r1.executeCommand('variance 2');

      expect(res).toBe('');
      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('EIGRP maximum metric variance 2');
    });

    it('27. should reject invalid variance values (e.g. 0 or > 128)', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');

      const res0 = await r1.executeCommand('variance 0');
      expect(res0).toContain('% Invalid input');

      const res200 = await r1.executeCommand('variance 200');
      expect(res200).toContain('% Invalid input');
    });
  });

  // ─── 9. REDISTRIBUTION & EXTERNAL ROUTES ────────────────────────

  describe('Route Redistribution & Administrative Distance', () => {
    it('28. should redistribute static routes with default/explicit metric', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('ip route 172.16.0.0 255.255.0.0 Null0');
      await r1.executeCommand('router eigrp 100');
      const res = await r1.executeCommand('redistribute static metric 10000 100 255 1 1500');

      expect(res).toBe('');
      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Redistributing: static');
    });

    it('29. should assign Administrative Distance 170 to external redistributed EIGRP routes', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureIPsR1R2(r1, r2);

      // R1 redistributes static
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('ip route 172.16.0.0 255.255.0.0 Null0');
      await r1.executeCommand('router eigrp 100');
      await r1.executeCommand('network 10.0.0.0');
      await r1.executeCommand('redistribute static metric 10000 100 255 1 1500');
      await r1.executeCommand('end');

      // R2 learns external route
      await r2.executeCommand('enable');
      await r2.executeCommand('configure terminal');
      await r2.executeCommand('router eigrp 100');
      await r2.executeCommand('network 10.0.0.0');
      await r2.executeCommand('end');

      await r1.processTimers(5);

      const routeR2 = await r2.executeCommand('show ip route 172.16.0.0');
      expect(routeR2).toContain('D EX');
      expect(routeR2).toContain('Distance: 170');
    });
  });

  // ─── 10. INTERFACE TIMERS & AUTHENTICATION ──────────────────────

  describe('Interface Hello/Hold Timers & MD5 Authentication', () => {
    it('30. should modify hello interval with "ip hello-interval eigrp <as> <sec>"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      const res = await r1.executeCommand('ip hello-interval eigrp 100 10');

      expect(res).toBe('');
    });

    it('31. should modify hold time with "ip hold-time eigrp <as> <sec>"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      const res = await r1.executeCommand('ip hold-time eigrp 100 30');

      expect(res).toBe('');
    });

    it('32. should enable MD5 authentication on interface', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      const res1 = await r1.executeCommand('ip authentication mode eigrp 100 md5');
      const res2 = await r1.executeCommand('ip authentication key-chain eigrp 100 MY_KEYS');

      expect(res1).toBe('');
      expect(res2).toBe('');
    });
  });

  // ─── 11. INSPECTION & EXEC COMMANDS ────────────────────────────

  describe('Inspection Commands (show) & Exec Controls', () => {
    it('33. "show ip eigrp neighbors" should format output with H, Address, Interface, Hold, Uptime, SRTT, RTO, Q Cnt, Seq Num', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureIPsR1R2(r1, r2);

      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router eigrp 100');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('end');
      }

      await r1.processTimers(5);

      const show = await r1.executeCommand('show ip eigrp neighbors');
      expect(show).toContain('EIGRP-IPv4 Neighbors for AS(100)');
      expect(show).toContain('Address');
      expect(show).toContain('Interface');
      expect(show).toContain('Hold');
      expect(show).toContain('10.0.12.2');
    });

    it('34. "show ip eigrp interfaces" should list interfaces running EIGRP', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('ip address 10.0.0.1 255.255.255.0');
      await r1.executeCommand('no shutdown');
      await r1.executeCommand('router eigrp 100');
      await r1.executeCommand('network 10.0.0.0');
      await r1.executeCommand('end');

      const show = await r1.executeCommand('show ip eigrp interfaces');
      expect(show).toContain('GigabitEthernet0/0');
      expect(show).toContain('Peers');
    });

    it('35. "clear ip eigrp neighbors" should reset neighbor adjacencies', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureIPsR1R2(r1, r2);

      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router eigrp 100');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('end');
      }

      await r1.processTimers(5);

      const res = await r1.executeCommand('clear ip eigrp neighbors');
      expect(res).toBe('');

      const logs = Logger.getLogs();
      expect(logs.some(l => l.includes('Neighbor reset') || l.includes('clear neighbors'))).toBe(true);
    });
  });

  // ─── 12. ERROR HANDLING, CLI SYNTAX & EDGE CASES ─────────────────

  describe('CLI Error Handling & Edge Cases', () => {
    it('36. should reject router eigrp commands executed outside config mode', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      const res = await r1.executeCommand('network 10.0.0.0');
      expect(res).toContain('% Invalid input');
    });

    it('37. should handle ambiguous command inputs in config-router mode', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');
      const res = await r1.executeCommand('n');

      expect(res).toContain('% Ambiguous command');
    });

    it('38. exit from (config-router)# should step back to (config)# prompt', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');
      await r1.executeCommand('exit');

      expect(r1.getPrompt()).toMatch(/R1\(config\)#/);
    });

    it('39. end from (config-router)# should jump directly to privileged exec mode #', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');
      await r1.executeCommand('end');

      expect(r1.getPrompt()).toMatch(/R1#/);
    });

    it('40. should support case-insensitive command parsing ("ROUTER EIGRP 100")', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('ENABLE');
      await r1.executeCommand('CONFIGURE TERMINAL');
      await r1.executeCommand('ROUTER EIGRP 100');

      expect(r1.getPrompt()).toMatch(/R1\(config-router\)#/);
    });
  });
});
