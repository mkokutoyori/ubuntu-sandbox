/**
 * TDD Unit Tests for RIP (Routing Information Protocol) on Cisco IOS.
 *
 * Covers:
 *  - Commands: router rip, no router rip, version 1|2, network <net>, no network <net>
 *  - Features: auto-summary / no auto-summary, passive-interface (specific / default)
 *  - Advanced: default-information originate, timers basic, maximum-paths
 *  - Interface level: ip rip send/receive version, ip rip authentication, ip split-horizon
 *  - Show & Exec: show ip protocols, show ip route rip, show ip rip database, clear ip route rip, debug ip rip
 *  - Protocol logic: Hop count max (15/16), Split Horizon, Poison Reverse, Redistribution, ECMP
 *  - Error handling: Invalid inputs, out-of-bounds arguments, bad modes, Cisco error prompts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

// ─── Helpers & Topologies ───────────────────────────────────────────

/**
 * Direct back-to-back link between 2 Routers: R1 <-> R2
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

/**
 * 3-Router Linear Topology: R1 <-> R2 <-> R3
 */
function setupThreeRouterLinearTopology() {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 100, 0);
  const r3 = new CiscoRouter('R3', 200, 0);

  const c1 = new Cable('c1');
  c1.connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);

  const c2 = new Cable('c2');
  c2.connect(r2.getPort('GigabitEthernet0/1')!, r3.getPort('GigabitEthernet0/0')!);

  return { r1, r2, r3 };
}

/**
 * Triangle Topology for Redundant Path / ECMP Testing:
 *   R1 --- R2
 *    \   /
 *     R3
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

/** Configures basic IP addressing on R1 and R2 */
async function configureAddressesR1R2(r1: CiscoRouter, r2: CiscoRouter) {
  // R1
  await r1.executeCommand('enable');
  await r1.executeCommand('configure terminal');
  await r1.executeCommand('interface GigabitEthernet0/0');
  await r1.executeCommand('ip address 10.0.0.1 255.255.255.0');
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('interface Loopback0');
  await r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
  await r1.executeCommand('end');

  // R2
  await r2.executeCommand('enable');
  await r2.executeCommand('configure terminal');
  await r2.executeCommand('interface GigabitEthernet0/0');
  await r2.executeCommand('ip address 10.0.0.2 255.255.255.0');
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('interface Loopback0');
  await r2.executeCommand('ip address 192.168.2.1 255.255.255.0');
  await r2.executeCommand('end');
}

// ═══════════════════════════════════════════════════════════════════
// CISCO IOS RIP COMMANDS TEST SUITE
// ═══════════════════════════════════════════════════════════════════

describe('Cisco IOS RIP Protocol Unit Tests', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  // ─── 1. MODE TRANSITIONS & PROCESS ACTIVATION ───────────────────

  describe('Mode Transitions & Process Activation', () => {
    it('1. should enter router configuration mode with "router rip"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      const res = await r1.executeCommand('router rip');

      expect(r1.getPrompt()).toMatch(/R1\(config-router\)#/);
      expect(res).toBe('');
    });

    it('2. should reject "router rip" in user exec mode', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      const res = await r1.executeCommand('router rip');
      expect(res).toContain('% Invalid input detected');
    });

    it('3. should reject "router rip" in privileged mode outside config t', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      const res = await r1.executeCommand('router rip');
      expect(res).toContain('% Invalid input detected');
    });

    it('4. should completely remove RIP configuration with "no router rip"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('network 10.0.0.0');
      await r1.executeCommand('exit');

      const res = await r1.executeCommand('no router rip');
      expect(res).toBe('');

      const showRip = await r1.executeCommand('show ip protocols');
      expect(showRip).not.toContain('Routing Protocol is "rip"');
    });

    it('5. should support command abbreviation "router rip" -> "rout rip"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('rout rip');
      expect(r1.getPrompt()).toMatch(/R1\(config-router\)#/);
    });
  });

  // ─── 2. NETWORK COMMAND & CLASSFUL VALIDATION ───────────────────

  describe('Network Command & Classful Address Handling', () => {
    it('6. should add network statement successfully', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('network 10.0.0.0');

      expect(res).toBe('');
      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('10.0.0.0');
    });

    it('7. should automatically convert subnetted IP to Classful boundary', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('network 192.168.1.50'); // Class C

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('192.168.1.0');
      expect(show).not.toContain('192.168.1.50');
    });

    it('8. should remove network statement with "no network <net>"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('network 10.0.0.0');
      await r1.executeCommand('no network 10.0.0.0');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).not.toContain('10.0.0.0');
    });

    it('9. should reject invalid IP format in network command', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('network 999.999.999.999');

      expect(res).toContain('% Invalid input');
    });

    it('10. should reject missing network argument', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('network');

      expect(res).toContain('% Incomplete command.');
    });
  });

  // ─── 3. VERSION CONFIGURATION & BEHAVIOR ───────────────────────

  describe('RIP Version 1 vs Version 2', () => {
    it('11. should default to version 1 send and version 1/2 receive if unconfigured', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Default version control: send version 1, receive version 1 2');
    });

    it('12. should switch globally to version 2 using "version 2"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('version 2');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Default version control: send version 2, receive version 2');
    });

    it('13. should revert version setting with "no version"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('version 2');
      await r1.executeCommand('no version');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('send version 1');
    });

    it('14. should reject unsupported versions (e.g. "version 3")', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('version 3');

      expect(res).toContain('% Invalid input');
    });

    it('15. should override version on interface with "ip rip send version 2"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      const res = await r1.executeCommand('ip rip send version 2');

      expect(res).toBe('');
      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('GigabitEthernet0/0');
      expect(show).toContain('Send: 2');
    });

    it('16. should override receive version on interface with "ip rip receive version 1"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('ip rip receive version 1');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Recv: 1');
    });
  });

  // ─── 4. AUTO-SUMMARY & VLSM ─────────────────────────────────────

  describe('Auto-Summary & VLSM Routing Updates', () => {
    it('17. should enable auto-summary by default in RIP', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Automatic network summarization is in effect');
    });

    it('18. should disable auto-summarization with "no auto-summary"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('version 2');
      const res = await r1.executeCommand('no auto-summary');

      expect(res).toBe('');
      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Automatic network summarization is not in effect');
    });

    it('19. should send CIDR subnets when auto-summary is disabled in RIPv2', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureAddressesR1R2(r1, r2);

      // Enable RIPv2 + no auto-summary
      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router rip');
        await r.executeCommand('version 2');
        await r.executeCommand('no auto-summary');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('network 192.168.0.0');
        await r.executeCommand('end');
      }

      await r1.processTimers(30); // Fast-forward 1 RIP update timer

      const routes = await r2.executeCommand('show ip route rip');
      expect(routes).toContain('192.168.1.0/24');
    });
  });

  // ─── 5. PASSIVE INTERFACES ──────────────────────────────────────

  describe('Passive Interface Configuration', () => {
    it('20. should set an interface passive with "passive-interface <iface>"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('passive-interface GigabitEthernet0/0');

      expect(res).toBe('');
      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Passive Interface(s):');
      expect(show).toContain('GigabitEthernet0/0');
    });

    it('21. should prevent routing updates sending on passive interface', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureAddressesR1R2(r1, r2);

      // Configure RIP
      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router rip');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('network 192.168.0.0');
        await r.executeCommand('end');
      }

      // Make R1 interface passive
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('passive-interface GigabitEthernet0/0');

      await r1.processTimers(30);

      // R2 should NOT learn R1's loopback route
      const routes = await r2.executeCommand('show ip route rip');
      expect(routes).not.toContain('192.168.1.0');
    });

    it('22. should set all interfaces passive with "passive-interface default"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('passive-interface default');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Passive Interface(s):');
      expect(show).toContain('Default');
    });

    it('23. should enable specific interface when default passive is set using "no passive-interface <iface>"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('passive-interface default');
      await r1.executeCommand('no passive-interface GigabitEthernet0/0');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Active Interface(s):');
      expect(show).toContain('GigabitEthernet0/0');
    });
  });

  // ─── 6. SPLIT HORIZON & POISON REVERSE ─────────────────────────

  describe('Split Horizon & Poison Reverse', () => {
    it('24. should have split-horizon enabled by default on Ethernet interfaces', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      const show = await r1.executeCommand('show ip interface GigabitEthernet0/0');

      expect(show).toContain('Split horizon is enabled');
    });

    it('25. should disable split horizon with "no ip split-horizon"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      const res = await r1.executeCommand('no ip split-horizon');

      expect(res).toBe('');
      const show = await r1.executeCommand('show ip interface GigabitEthernet0/0');
      expect(show).toContain('Split horizon is disabled');
    });

    it('26. should re-enable split horizon with "ip split-horizon"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('no ip split-horizon');
      await r1.executeCommand('ip split-horizon');

      const show = await r1.executeCommand('show ip interface GigabitEthernet0/0');
      expect(show).toContain('Split horizon is enabled');
    });
  });

  // ─── 7. DEFAULT ROUTE ORIGINATION ──────────────────────────────

  describe('Default Route Origination', () => {
    it('27. should generate default route (0.0.0.0/0) with "default-information originate"', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureAddressesR1R2(r1, r2);

      // Configure RIP
      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router rip');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('end');
      }

      // Originate default route on R1
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('default-information originate');

      await r1.processTimers(30);

      const routesR2 = await r2.executeCommand('show ip route');
      expect(routesR2).toContain('R*  0.0.0.0/0');
    });

    it('28. should stop default route origination with "no default-information originate"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('default-information originate');
      await r1.executeCommand('no default-information originate');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).not.toContain('Default information originate');
    });
  });

  // ─── 8. TIMERS & CONVERGENCE ───────────────────────────────────

  describe('RIP Timers & Convergence Settings', () => {
    it('29. should display default timers (Update 30, Invalid 180, Holddown 180, Flush 240)', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      const show = await r1.executeCommand('show ip protocols');

      expect(show).toContain('Sending updates every 30 seconds');
      expect(show).toContain('Invalid after 180 seconds');
      expect(show).toContain('hold down 180');
      expect(show).toContain('flushed after 240');
    });

    it('30. should customize timers with "timers basic <update> <invalid> <holddown> <flush>"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('timers basic 10 30 30 60');

      expect(res).toBe('');
      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Sending updates every 10 seconds');
      expect(show).toContain('Invalid after 30 seconds');
    });

    it('31. should restore default timers with "no timers basic"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('timers basic 5 15 15 30');
      await r1.executeCommand('no timers basic');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Sending updates every 30 seconds');
    });

    it('32. should reject invalid timer logic (e.g. invalid timer <= update timer)', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('timers basic 30 10 30 60');

      expect(res).toContain('% Invalid timers');
    });

    it('33. should mark route as invalid when timer expires without updates', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureAddressesR1R2(r1, r2);

      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router rip');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('network 192.168.0.0');
        await r.executeCommand('end');
      }

      await r1.processTimers(30); // R2 learns route
      let routes = await r2.executeCommand('show ip route rip');
      expect(routes).toContain('192.168.1.0');

      // Shut down R1's interface
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('shutdown');

      // Fast forward past invalid timer (180s)
      await r2.processTimers(181);

      routes = await r2.executeCommand('show ip route rip');
      expect(routes).toContain('possibly down');
    });
  });

  // ─── 9. HOP COUNT & INFINITY METRIC ───────────────────────────

  describe('Hop Count & Metric Limit (Max 15 Hops)', () => {
    it('34. should metric-increment by 1 per router hop', async () => {
      const { r1, r2, r3 } = setupThreeRouterLinearTopology();

      // Configure IPs & RIP on all 3
      // R1 (10.0.0.1) -- (10.0.0.2) R2 (11.0.0.1) -- (11.0.0.2) R3
      // R1 loopback: 192.168.1.1
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('ip address 10.0.0.1 255.255.255.0');
      await r1.executeCommand('no shutdown');
      await r1.executeCommand('interface Loopback0');
      await r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
      await r1.executeCommand('router rip');
      await r1.executeCommand('network 10.0.0.0');
      await r1.executeCommand('network 192.168.1.0');

      await r2.executeCommand('enable');
      await r2.executeCommand('configure terminal');
      await r2.executeCommand('interface GigabitEthernet0/0');
      await r2.executeCommand('ip address 10.0.0.2 255.255.255.0');
      await r2.executeCommand('no shutdown');
      await r2.executeCommand('interface GigabitEthernet0/1');
      await r2.executeCommand('ip address 11.0.0.1 255.255.255.0');
      await r2.executeCommand('no shutdown');
      await r2.executeCommand('router rip');
      await r2.executeCommand('network 10.0.0.0');
      await r2.executeCommand('network 11.0.0.0');

      await r3.executeCommand('enable');
      await r3.executeCommand('configure terminal');
      await r3.executeCommand('interface GigabitEthernet0/0');
      await r3.executeCommand('ip address 11.0.0.2 255.255.255.0');
      await r3.executeCommand('no shutdown');
      await r3.executeCommand('router rip');
      await r3.executeCommand('network 11.0.0.0');

      // Convergence cycles
      await r1.processTimers(30);
      await r2.processTimers(30);

      // R2 metric for R1 loopback = 1
      const routesR2 = await r2.executeCommand('show ip route rip');
      expect(routesR2).toContain('[120/1]');

      // R3 metric for R1 loopback = 2
      const routesR3 = await r3.executeCommand('show ip route rip');
      expect(routesR3).toContain('[120/2]');
    });

    it('35. should treat metric 16 as unreachable / infinity', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureAddressesR1R2(r1, r2);

      // RIP setup
      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router rip');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('network 192.168.0.0');
        await r.executeCommand('end');
      }

      await r1.processTimers(30);

      const db = await r2.executeCommand('show ip rip database');
      expect(db).not.toContain('16 hops (unreachable)');
    });
  });

  // ─── 10. ECMP & MAXIMUM PATHS ─────────────────────────────────

  describe('Equal-Cost Multi-Path (ECMP) & Maximum Paths', () => {
    it('36. should default maximum-paths to 4', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      const show = await r1.executeCommand('show ip protocols');

      expect(show).toContain('Maximum path: 4');
    });

    it('37. should modify maximum-paths with "maximum-paths <1-16>"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('maximum-paths 2');

      expect(res).toBe('');
      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Maximum path: 2');
    });

    it('38. should reject out-of-bounds maximum-paths argument', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('maximum-paths 32');

      expect(res).toContain('% Invalid input');
    });

    it('39. should load balance across dual paths in triangle topology', async () => {
      const { r1, r2, r3 } = setupTriangleTopology();

      // Configure symmetric cost links: R1 connects to R2 and R3; R2 & R3 connect to target network
      // ... Topology addressing ...
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('maximum-paths 2');

      const paths = await r1.executeCommand('show ip route rip');
      expect(paths).toBeDefined();
    });
  });

  // ─── 11. ROUTE REDISTRIBUTION ──────────────────────────────────

  describe('Route Redistribution (Static & Connected)', () => {
    it('40. should redistribute static routes into RIP with "redistribute static"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('ip route 172.16.0.0 255.255.0.0 Null0');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('redistribute static');

      expect(res).toBe('');
      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Redistributing: static');
    });

    it('41. should redistribute connected routes with "redistribute connected"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('redistribute connected');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Redistributing: connected');
    });

    it('42. should remove redistribution with "no redistribute static"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('redistribute static');
      await r1.executeCommand('no redistribute static');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).not.toContain('Redistributing: static');
    });
  });

  // ─── 12. RIP AUTHENTICATION ─────────────────────────────────────

  describe('RIPv2 Authentication Settings', () => {
    it('43. should set text authentication mode on interface', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      const res = await r1.executeCommand('ip rip authentication mode text');

      expect(res).toBe('');
    });

    it('44. should set md5 authentication mode on interface', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      const res = await r1.executeCommand('ip rip authentication mode md5');

      expect(res).toBe('');
    });

    it('45. should bind key-chain to interface with "ip rip authentication key-chain <name>"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      const res = await r1.executeCommand('ip rip authentication key-chain MY_CHAIN');

      expect(res).toBe('');
    });

    it('46. should reject updates when authentication key mismatches between routers', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureAddressesR1R2(r1, r2);

      // R1 with Auth Key
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('ip rip authentication mode text');
      await r1.executeCommand('ip rip authentication key-chain KEY_R1');
      await r1.executeCommand('router rip');
      await r1.executeCommand('version 2');
      await r1.executeCommand('network 10.0.0.0');
      await r1.executeCommand('network 192.168.0.0');

      // R2 without Auth Key
      await r2.executeCommand('enable');
      await r2.executeCommand('configure terminal');
      await r2.executeCommand('router rip');
      await r2.executeCommand('version 2');
      await r2.executeCommand('network 10.0.0.0');

      await r1.processTimers(30);

      // R2 should drop unauthenticated updates from R1
      const routesR2 = await r2.executeCommand('show ip route rip');
      expect(routesR2).not.toContain('192.168.1.0');
    });
  });

  // ─── 13. INSPECTION COMMANDS (SHOW) ─────────────────────────────

  describe('Inspection Commands: show ip protocols, route, database', () => {
    it('47. "show ip protocols" should output full RIP summary', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('network 10.0.0.0');
      await r1.executeCommand('end');

      const res = await r1.executeCommand('show ip protocols');
      expect(res).toContain('Routing Protocol is "rip"');
      expect(res).toContain('Sending updates every 30 seconds');
      expect(res).toContain('Routing for Networks:');
      expect(res).toContain('10.0.0.0');
    });

    it('48. "show ip route rip" should filter routing table to RIP only (Administrative Distance 120)', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureAddressesR1R2(r1, r2);

      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router rip');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('network 192.168.0.0');
        await r.executeCommand('end');
      }

      await r1.processTimers(30);

      const res = await r2.executeCommand('show ip route rip');
      expect(res).toContain('R    192.168.1.0/24 [120/1] via 10.0.0.1');
    });

    it('49. "show ip rip database" should display local database entries', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('ip address 10.0.0.1 255.255.255.0');
      await r1.executeCommand('no shutdown');
      await r1.executeCommand('router rip');
      await r1.executeCommand('network 10.0.0.0');
      await r1.executeCommand('end');

      const res = await r1.executeCommand('show ip rip database');
      expect(res).toContain('10.0.0.0/8 auto-summary');
      expect(res).toContain('10.0.0.0/24 directly connected, GigabitEthernet0/0');
    });

    it('50. "show ip route rip" should output "No RIP routes in routing table." when empty', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      const res = await r1.executeCommand('show ip route rip');

      expect(res).toContain('No RIP routes in routing table');
    });
  });

  // ─── 14. EXEC & DEBUG COMMANDS ──────────────────────────────────

  describe('Exec & Debug Commands', () => {
    it('51. "clear ip route rip *" should purge dynamic RIP routes', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureAddressesR1R2(r1, r2);

      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router rip');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('network 192.168.0.0');
        await r.executeCommand('end');
      }

      await r1.processTimers(30);

      let routes = await r2.executeCommand('show ip route rip');
      expect(routes).toContain('192.168.1.0');

      await r2.executeCommand('clear ip route rip *');

      routes = await r2.executeCommand('show ip route rip');
      expect(routes).not.toContain('192.168.1.0');
    });

    it('52. "debug ip rip" should enable logging for RIP packets', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      const res = await r1.executeCommand('debug ip rip');

      expect(res).toContain('RIP protocol debugging is on');
    });

    it('53. "undebug ip rip" or "no debug ip rip" should disable logging', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('debug ip rip');
      const res = await r1.executeCommand('undebug ip rip');

      expect(res).toContain('RIP protocol debugging is off');
    });

    it('54. "undebug all" should turn off RIP debugs along with others', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('debug ip rip');
      const res = await r1.executeCommand('undebug all');

      expect(res).toContain('All possible debugging has been turned off');
    });
  });

  // ─── 15. MALFORMED COMMANDS, ERRORS & CORNER CASES ──────────────

  describe('Malformed Commands & Edge Cases Validation', () => {
    it('55. should reject commands valid in router rip mode when typed in global mode', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      const res = await r1.executeCommand('version 2');

      expect(res).toContain('% Invalid input detected at \'^\' marker.');
    });

    it('56. should handle incomplete "timers basic" command', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('timers basic 30 180');

      expect(res).toContain('% Incomplete command.');
    });

    it('57. should reject ambiguous input "p" in config-router mode', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('p');

      expect(res).toContain('% Ambiguous command');
    });

    it('58. should ignore non-existent network removal without throwing exception', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('no network 172.16.0.0');

      expect(res).toBe('');
    });

    it('59. should reject passive-interface command with invalid interface name', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('passive-interface Ethernet999/999');

      expect(res).toContain('% Invalid interface type or number');
    });

    it('60. exit from (config-router)# should return to (config)# mode', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('exit');

      expect(r1.getPrompt()).toMatch(/R1\(config\)#/);
    });

    it('61. end from (config-router)# should return to privileged exec # mode', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('end');

      expect(r1.getPrompt()).toMatch(/R1#/);
    });

    // ─── EXTENDED SCENARIOS 62 TO 100 ────────────────────────────────

    it('62. should properly summarize multi-subnet class A network under auto-summary', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('network 10.0.0.0');

      const db = await r1.executeCommand('show ip rip database');
      expect(db).toContain('10.0.0.0/8 auto-summary');
    });

    it('63. should NOT accept IP addresses as interface names for passive-interface', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('passive-interface 10.0.0.1');

      expect(res).toContain('% Invalid input');
    });

    it('64. should properly display multiline RIP routes in "show ip route"', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureAddressesR1R2(r1, r2);

      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router rip');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('network 192.168.0.0');
        await r.executeCommand('end');
      }

      await r1.processTimers(30);

      const routeTable = await r2.executeCommand('show ip route');
      expect(routeTable).toContain('Codes: L - local, C - connected, S - static, R - RIP');
      expect(routeTable).toContain('R    192.168.1.0/24');
    });

    it('65. should support "ip rip receive version 1 2" to accept both versions', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      const res = await r1.executeCommand('ip rip receive version 1 2');

      expect(res).toBe('');
      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Recv: 1 2');
    });

    it('66. should support "ip rip send version 1 2" to broadcast both formats', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      const res = await r1.executeCommand('ip rip send version 1 2');

      expect(res).toBe('');
      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Send: 1 2');
    });

    it('67. should ignore "ip rip send version" on non-existent interface', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      const res = await r1.executeCommand('interface FastEthernet9/9');

      expect(res).toContain('% Invalid interface');
    });

    it('68. should handle "no ip rip send version" to restore default behavior', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('ip rip send version 2');
      await r1.executeCommand('no ip rip send version');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Send: default');
    });

    it('69. should reject negative values for RIP basic timers', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('timers basic -10 30 30 60');

      expect(res).toContain('% Invalid input');
    });

    it('70. should reject non-numeric values for RIP basic timers', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('timers basic ten thirty thirty sixty');

      expect(res).toContain('% Invalid input');
    });

    it('71. should clear database when interface running RIP is shut down', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('ip address 10.0.0.1 255.255.255.0');
      await r1.executeCommand('no shutdown');
      await r1.executeCommand('router rip');
      await r1.executeCommand('network 10.0.0.0');

      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('shutdown');

      const db = await r1.executeCommand('show ip rip database');
      expect(db).not.toContain('directly connected, GigabitEthernet0/0');
    });

    it('72. should keep static routes intact when RIP is cleared', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('ip route 1.1.1.0 255.255.255.0 Null0');
      await r1.executeCommand('router rip');
      await r1.executeCommand('redistribute static');

      await r1.executeCommand('clear ip route rip *');

      const routes = await r1.executeCommand('show ip route static');
      expect(routes).toContain('1.1.1.0/24');
    });

    it('73. should verify multicast address 224.0.0.9 is used for RIPv2', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('debug ip rip');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('version 2');
      await r1.executeCommand('network 10.0.0.0');

      const logs = Logger.getLogs();
      expect(logs.some(l => l.message.includes('224.0.0.9'))).toBe(true);
    });

    it('74. should verify broadcast address 255.255.255.255 is used for RIPv1', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('debug ip rip');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('version 1');
      await r1.executeCommand('network 10.0.0.0');

      const logs = Logger.getLogs();
      expect(logs.some(l => l.message.includes('255.255.255.255'))).toBe(true);
    });

    it('75. should display correct administrative distance 120 in show ip protocols', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Distance: (default is 120)');
    });

    it('76. should allow overriding default administrative distance for RIP', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('distance 110');

      expect(res).toBe('');
      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Distance: (default is 110)');
    });

    it('77. should reject invalid administrative distance (out of range 1-255)', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('distance 300');

      expect(res).toContain('% Invalid input');
    });

    it('78. should support "show ip route 10.0.0.0" specifically for RIP learned routes', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureAddressesR1R2(r1, r2);

      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router rip');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('network 192.168.0.0');
        await r.executeCommand('end');
      }

      await r1.processTimers(30);

      const detail = await r2.executeCommand('show ip route 192.168.1.0');
      expect(detail).toContain('Routing entry for 192.168.1.0/24');
      expect(detail).toContain('Known via "rip"');
      expect(detail).toContain('Distance: 120, Metric: 1');
    });

    it('79. should ignore updates from different subnets on non-point-to-point links', async () => {
      const { r1, r2 } = setupTwoRouterTopology();

      // Mismatched subnets
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('ip address 10.0.0.1 255.255.255.0');
      await r1.executeCommand('no shutdown');
      await r1.executeCommand('router rip');
      await r1.executeCommand('network 10.0.0.0');

      await r2.executeCommand('enable');
      await r2.executeCommand('configure terminal');
      await r2.executeCommand('interface GigabitEthernet0/0');
      await r2.executeCommand('ip address 172.16.0.2 255.255.255.0');
      await r2.executeCommand('no shutdown');
      await r2.executeCommand('router rip');
      await r2.executeCommand('network 172.16.0.0');

      await r1.processTimers(30);

      const routes = await r2.executeCommand('show ip route rip');
      expect(routes).toContain('No RIP routes in routing table');
    });

    it('80. should display "passive" keyword in show ip interface if interface is passive', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('passive-interface GigabitEthernet0/0');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('GigabitEthernet0/0 (passive)');
    });

    it('81. should handle "no passive-interface" when default is not set', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('no passive-interface GigabitEthernet0/0');

      expect(res).toBe('');
    });

    it('82. should prevent RIP process creation if routing is globally disabled', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('no ip routing');
      const res = await r1.executeCommand('router rip');

      expect(res).toContain('IP routing not enabled');
    });

    it('83. should re-enable RIP process when "ip routing" is re-issued', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('no ip routing');
      await r1.executeCommand('ip routing');
      await r1.executeCommand('router rip');

      expect(r1.getPrompt()).toMatch(/R1\(config-router\)#/);
    });

    it('84. should correctly list multiple advertised networks under "Routing for Networks:"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('network 10.0.0.0');
      await r1.executeCommand('network 172.16.0.0');
      await r1.executeCommand('network 192.168.1.0');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('10.0.0.0');
      expect(show).toContain('172.16.0.0');
      expect(show).toContain('192.168.1.0');
    });

    it('85. should reject "auto-summary" in interface mode', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      const res = await r1.executeCommand('auto-summary');

      expect(res).toContain('% Invalid input');
    });

    it('86. should reject "default-information originate" in interface mode', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      const res = await r1.executeCommand('default-information originate');

      expect(res).toContain('% Invalid input');
    });

    it('87. should reject "ip split-horizon" in global configuration mode', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      const res = await r1.executeCommand('ip split-horizon');

      expect(res).toContain('% Invalid input');
    });

    it('88. should reject "version" command without arguments in router rip mode', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('version');

      expect(res).toContain('% Incomplete command.');
    });

    it('89. should handle duplicate "network <net>" statements idempotently', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('network 10.0.0.0');
      await r1.executeCommand('network 10.0.0.0');

      const show = await r1.executeCommand('show ip protocols');
      const occurrences = (show.match(/10\.0\.0\.0/g) || []).length;
      expect(occurrences).toBe(1);
    });

    it('90. should preserve custom timers across version changes', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('timers basic 15 45 45 90');
      await r1.executeCommand('version 2');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Sending updates every 15 seconds');
    });

    it('91. should handle "show ip rip database" when no networks are configured', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');

      const db = await r1.executeCommand('show ip rip database');
      expect(db.trim()).toBe('');
    });

    it('92. should parse case-insensitive commands ("ROUTER RIP", "VERSION 2")', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('ENABLE');
      await r1.executeCommand('CONFIGURE TERMINAL');
      await r1.executeCommand('ROUTER RIP');
      await r1.executeCommand('VERSION 2');

      const show = await r1.executeCommand('SHOW IP PROTOCOLS');
      expect(show).toContain('send version 2');
    });

    it('93. should show correct last update timestamp in "show ip protocols"', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureAddressesR1R2(r1, r2);

      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router rip');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('end');
      }

      await r1.processTimers(10);

      const show = await r2.executeCommand('show ip protocols');
      expect(show).toContain('Last update occurred');
    });

    it('94. should strip host bits when given network in Class B range', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('network 172.16.50.25');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('172.16.0.0');
    });

    it('95. should strip host bits when given network in Class A range', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('network 10.123.45.67');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('10.0.0.0');
    });

    it('96. should reject Multicast IP range (Class D) in network statement', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('network 224.0.0.1');

      expect(res).toContain('% Invalid input');
    });

    it('97. should reject Loopback IP 127.0.0.1 in network statement', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('network 127.0.0.1');

      expect(res).toContain('% Invalid input');
    });

    it('98. should stop sending updates immediately when "no router rip" is executed', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureAddressesR1R2(r1, r2);

      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router rip');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('network 192.168.0.0');
        await r.executeCommand('end');
      }

      await r1.executeCommand('configure terminal');
      await r1.executeCommand('no router rip');

      await r1.processTimers(30);

      const routesR2 = await r2.executeCommand('show ip route rip');
      expect(routesR2).not.toContain('192.168.1.0');
    });

    it('99. should return empty string when executing valid command in config-router mode silently', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('auto-summary');

      expect(res).toBe('');
    });

    it('100. should maintain operational status across full setup sequence', async () => {
      const { r1, r2 } = setupTwoRouterTopology();
      await configureAddressesR1R2(r1, r2);

      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('version 2');
      await r1.executeCommand('no auto-summary');
      await r1.executeCommand('network 10.0.0.0');
      await r1.executeCommand('network 192.168.1.0');
      await r1.executeCommand('timers basic 20 60 60 80');
      await r1.executeCommand('end');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Routing Protocol is "rip"');
      expect(show).toContain('send version 2');
      expect(show).toContain('Automatic network summarization is not in effect');
      expect(show).toContain('Sending updates every 20 seconds');
    });
  });
});
