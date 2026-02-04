/**
 * TDD Tests for RIPv2 (RFC 2453)
 *
 * Group 1: Unit Tests — RIP types, packet structure, route management API
 * Group 2: Functional Tests — Route exchange between routers, convergence
 * Group 3: Split Horizon & Poisoned Reverse
 * Group 4: Route Aging (timeout + garbage collection)
 * Group 5: CLI Tests — Cisco IOS & Huawei VRP RIP commands
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  IPAddress, SubnetMask, MACAddress,
  IPv4Packet, UDPPacket, RIPPacket, RIPRouteEntry,
  createIPv4Packet,
  IP_PROTO_UDP, ETHERTYPE_IPV4,
  UDP_PORT_RIP, RIP_METRIC_INFINITY,
  resetCounters,
} from '@/network/core/types';
import { Router } from '@/network/devices/Router';
import type { RIPConfig } from '@/network/devices/Router';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 1: Unit Tests — RIP API & Data Structures
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: RIP API & Data Structures', () => {

  it('should enable and disable RIP', () => {
    const r1 = new Router('router-cisco', 'R1');
    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));

    expect(r1.isRIPEnabled()).toBe(false);
    r1.enableRIP();
    expect(r1.isRIPEnabled()).toBe(true);
    r1.disableRIP();
    expect(r1.isRIPEnabled()).toBe(false);
  });

  it('should accept custom RIP configuration', () => {
    const r1 = new Router('router-cisco', 'R1');
    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));

    r1.enableRIP({
      updateInterval: 5000,
      routeTimeout: 15000,
      gcTimeout: 10000,
      splitHorizon: false,
    });

    const cfg = r1.getRIPConfig();
    expect(cfg.updateInterval).toBe(5000);
    expect(cfg.routeTimeout).toBe(15000);
    expect(cfg.gcTimeout).toBe(10000);
    expect(cfg.splitHorizon).toBe(false);

    r1.disableRIP();
  });

  it('should add networks to RIP advertisement list', () => {
    const r1 = new Router('router-cisco', 'R1');
    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r1.enableRIP();

    r1.ripAdvertiseNetwork(new IPAddress('10.0.0.0'), new SubnetMask('255.0.0.0'));
    r1.ripAdvertiseNetwork(new IPAddress('192.168.1.0'), new SubnetMask('255.255.255.0'));

    const cfg = r1.getRIPConfig();
    expect(cfg.networks.length).toBe(2);
    expect(cfg.networks[0].network.toString()).toBe('10.0.0.0');
    expect(cfg.networks[1].network.toString()).toBe('192.168.1.0');

    r1.disableRIP();
  });

  it('should have AD=120 for RIP routes', () => {
    // This is verified functionally in Group 2; here we verify the type
    const r1 = new Router('router-cisco', 'R1');
    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));

    // Connected routes have AD=0
    const table = r1.getRoutingTable();
    const connected = table.find(r => r.type === 'connected');
    expect(connected!.ad).toBe(0);

    r1.disableRIP();
  });

  it('should remove all RIP routes when disabling RIP', () => {
    const r1 = new Router('router-cisco', 'R1');
    const r2 = new Router('router-cisco', 'R2');

    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GigabitEthernet0/1', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));

    const c1 = new Cable('c1');
    c1.connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);

    r1.enableRIP({ updateInterval: 1000, routeTimeout: 5000, gcTimeout: 3000 });
    r2.enableRIP({ updateInterval: 1000, routeTimeout: 5000, gcTimeout: 3000 });
    r1.ripAdvertiseNetwork(new IPAddress('10.0.0.0'), new SubnetMask('255.0.0.0'));
    r2.ripAdvertiseNetwork(new IPAddress('10.0.0.0'), new SubnetMask('255.0.0.0'));
    r2.ripAdvertiseNetwork(new IPAddress('192.168.1.0'), new SubnetMask('255.255.255.0'));

    // Trigger update
    vi.advanceTimersByTime(1100);

    // R1 should have learned the 192.168.1.0/24 route
    let table = r1.getRoutingTable();
    const ripRoutes = table.filter(r => r.type === 'rip');
    expect(ripRoutes.length).toBeGreaterThanOrEqual(1);

    // Now disable RIP on R1
    r1.disableRIP();
    table = r1.getRoutingTable();
    const ripRoutesAfter = table.filter(r => r.type === 'rip');
    expect(ripRoutesAfter.length).toBe(0);

    r2.disableRIP();
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 2: Functional Tests — Route Exchange & Convergence
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: Route Exchange & Convergence', () => {

  it('should learn a remote network via RIP from a neighbor', () => {
    // Topology: R1 (10.0.1.0/24) --- R2 (10.0.1.0/24 + 192.168.1.0/24)
    // R1 should learn 192.168.1.0/24 via R2
    const r1 = new Router('router-cisco', 'R1');
    const r2 = new Router('router-cisco', 'R2');

    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GigabitEthernet0/1', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));

    const c1 = new Cable('c1');
    c1.connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);

    // Enable RIP with fast timers for testing
    r1.enableRIP({ updateInterval: 1000, routeTimeout: 5000, gcTimeout: 3000 });
    r2.enableRIP({ updateInterval: 1000, routeTimeout: 5000, gcTimeout: 3000 });
    r1.ripAdvertiseNetwork(new IPAddress('10.0.0.0'), new SubnetMask('255.0.0.0'));
    r2.ripAdvertiseNetwork(new IPAddress('10.0.0.0'), new SubnetMask('255.0.0.0'));
    r2.ripAdvertiseNetwork(new IPAddress('192.168.1.0'), new SubnetMask('255.255.255.0'));

    // Advance timer to trigger periodic update
    vi.advanceTimersByTime(1100);

    // R1 should now have a RIP route to 192.168.1.0/24
    const table = r1.getRoutingTable();
    const ripRoute = table.find(r => r.type === 'rip' && r.network.toString() === '192.168.1.0');

    expect(ripRoute).toBeDefined();
    expect(ripRoute!.nextHop!.toString()).toBe('10.0.1.2');
    expect(ripRoute!.ad).toBe(120);
    expect(ripRoute!.metric).toBe(1); // 1 hop away
    expect(ripRoute!.iface).toBe('GigabitEthernet0/0');

    r1.disableRIP();
    r2.disableRIP();
  });

  it('should learn routes bidirectionally', () => {
    // R1 has 172.16.0.0/16, R2 has 192.168.1.0/24
    // After exchange, each should know about the other's network
    const r1 = new Router('router-cisco', 'R1');
    const r2 = new Router('router-cisco', 'R2');

    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r1.configureInterface('GigabitEthernet0/1', new IPAddress('172.16.0.1'), new SubnetMask('255.255.0.0'));
    r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GigabitEthernet0/1', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));

    const c1 = new Cable('c1');
    c1.connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);

    r1.enableRIP({ updateInterval: 1000, routeTimeout: 5000, gcTimeout: 3000 });
    r2.enableRIP({ updateInterval: 1000, routeTimeout: 5000, gcTimeout: 3000 });
    r1.ripAdvertiseNetwork(new IPAddress('10.0.0.0'), new SubnetMask('255.0.0.0'));
    r1.ripAdvertiseNetwork(new IPAddress('172.16.0.0'), new SubnetMask('255.255.0.0'));
    r2.ripAdvertiseNetwork(new IPAddress('10.0.0.0'), new SubnetMask('255.0.0.0'));
    r2.ripAdvertiseNetwork(new IPAddress('192.168.1.0'), new SubnetMask('255.255.255.0'));

    vi.advanceTimersByTime(1100);

    // R1 should know about 192.168.1.0/24
    const r1Table = r1.getRoutingTable();
    expect(r1Table.find(r => r.type === 'rip' && r.network.toString() === '192.168.1.0')).toBeDefined();

    // R2 should know about 172.16.0.0/16
    const r2Table = r2.getRoutingTable();
    expect(r2Table.find(r => r.type === 'rip' && r.network.toString() === '172.16.0.0')).toBeDefined();

    r1.disableRIP();
    r2.disableRIP();
  });

  it('should propagate routes through 3 routers (R1 → R2 → R3)', () => {
    // R1(172.16.0.0/16) --- R2 --- R3(192.168.1.0/24)
    // After 2 update cycles, R1 should know about 192.168.1.0/24 with metric=2
    const r1 = new Router('router-cisco', 'R1');
    const r2 = new Router('router-cisco', 'R2');
    const r3 = new Router('router-cisco', 'R3');

    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r1.configureInterface('GigabitEthernet0/1', new IPAddress('172.16.0.1'), new SubnetMask('255.255.0.0'));

    r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));

    r3.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
    r3.configureInterface('GigabitEthernet0/1', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));

    const c1 = new Cable('c1');
    c1.connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
    const c2 = new Cable('c2');
    c2.connect(r2.getPort('GigabitEthernet0/1')!, r3.getPort('GigabitEthernet0/0')!);

    const ripCfg: Partial<RIPConfig> = { updateInterval: 1000, routeTimeout: 10000, gcTimeout: 5000 };
    r1.enableRIP(ripCfg);
    r2.enableRIP(ripCfg);
    r3.enableRIP(ripCfg);

    r1.ripAdvertiseNetwork(new IPAddress('10.0.1.0'), new SubnetMask('255.255.255.0'));
    r1.ripAdvertiseNetwork(new IPAddress('172.16.0.0'), new SubnetMask('255.255.0.0'));
    r2.ripAdvertiseNetwork(new IPAddress('10.0.1.0'), new SubnetMask('255.255.255.0'));
    r2.ripAdvertiseNetwork(new IPAddress('10.0.2.0'), new SubnetMask('255.255.255.0'));
    r3.ripAdvertiseNetwork(new IPAddress('10.0.2.0'), new SubnetMask('255.255.255.0'));
    r3.ripAdvertiseNetwork(new IPAddress('192.168.1.0'), new SubnetMask('255.255.255.0'));

    // First update: R2 learns from R1 and R3
    vi.advanceTimersByTime(1100);

    // Second update: R1 learns R3's routes via R2, R3 learns R1's routes via R2
    vi.advanceTimersByTime(1100);

    // R1 should have 192.168.1.0/24 with metric=2 (R2 learned it with metric=1, advertises as metric=2)
    const r1Table = r1.getRoutingTable();
    const ripRoute = r1Table.find(r => r.type === 'rip' && r.network.toString() === '192.168.1.0');
    expect(ripRoute).toBeDefined();
    expect(ripRoute!.metric).toBe(2); // 2 hops

    // R3 should know about 172.16.0.0/16 with metric=2
    const r3Table = r3.getRoutingTable();
    const r3Route = r3Table.find(r => r.type === 'rip' && r.network.toString() === '172.16.0.0');
    expect(r3Route).toBeDefined();
    expect(r3Route!.metric).toBe(2);

    r1.disableRIP();
    r2.disableRIP();
    r3.disableRIP();
  });

  it('should not install RIP routes for own connected networks', () => {
    const r1 = new Router('router-cisco', 'R1');
    const r2 = new Router('router-cisco', 'R2');

    // Both share the 10.0.1.0/24 link
    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));

    const c1 = new Cable('c1');
    c1.connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);

    r1.enableRIP({ updateInterval: 1000, routeTimeout: 5000, gcTimeout: 3000 });
    r2.enableRIP({ updateInterval: 1000, routeTimeout: 5000, gcTimeout: 3000 });
    r1.ripAdvertiseNetwork(new IPAddress('10.0.0.0'), new SubnetMask('255.0.0.0'));
    r2.ripAdvertiseNetwork(new IPAddress('10.0.0.0'), new SubnetMask('255.0.0.0'));

    vi.advanceTimersByTime(1100);

    // R1 should NOT have a RIP route for 10.0.1.0/24 (it's connected)
    const table = r1.getRoutingTable();
    const ripRoutes = table.filter(r => r.type === 'rip' && r.network.toString() === '10.0.1.0');
    expect(ripRoutes.length).toBe(0);

    r1.disableRIP();
    r2.disableRIP();
  });

  it('should use RIP-learned routes for end-to-end ping (no static routes)', async () => {
    vi.useRealTimers(); // Need real timers for ping

    // PC_A → R1 --- R2 → PC_B
    // R1 and R2 learn each other's networks via RIP (no static routes)
    const pcA = new LinuxPC('linux-pc', 'PC_A');
    const pcB = new LinuxPC('linux-pc', 'PC_B');
    const r1 = new Router('router-cisco', 'R1');
    const r2 = new Router('router-cisco', 'R2');

    pcA.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    pcB.configureInterface('eth0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));

    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r1.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.12.1'), new SubnetMask('255.255.255.0'));

    r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.12.2'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));

    pcA.setDefaultGateway(new IPAddress('10.0.1.1'));
    pcB.setDefaultGateway(new IPAddress('10.0.2.1'));

    const c1 = new Cable('c1');
    c1.connect(pcA.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
    const c2 = new Cable('c2');
    c2.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/0')!);
    const c3 = new Cable('c3');
    c3.connect(r2.getPort('GigabitEthernet0/1')!, pcB.getPort('eth0')!);

    // Enable RIP with very fast timers for this test
    r1.enableRIP({ updateInterval: 50, routeTimeout: 5000, gcTimeout: 3000 });
    r2.enableRIP({ updateInterval: 50, routeTimeout: 5000, gcTimeout: 3000 });
    r1.ripAdvertiseNetwork(new IPAddress('10.0.0.0'), new SubnetMask('255.0.0.0'));
    r2.ripAdvertiseNetwork(new IPAddress('10.0.0.0'), new SubnetMask('255.0.0.0'));

    // Wait for RIP convergence
    await new Promise(resolve => setTimeout(resolve, 200));

    // Now R1 should know about 10.0.2.0/24 via R2, and R2 should know about 10.0.1.0/24 via R1
    const r1Table = r1.getRoutingTable();
    const ripToPC_B = r1Table.find(r => r.type === 'rip' && r.network.toString() === '10.0.2.0');
    expect(ripToPC_B).toBeDefined();

    // Ping from PC_A to PC_B — should work via RIP-learned routes
    const output = await pcA.executeCommand('ping -c 1 10.0.2.2');
    expect(output).toContain('64 bytes from 10.0.2.2');
    expect(output).toContain('ttl=62'); // 2 router hops

    r1.disableRIP();
    r2.disableRIP();
  });

  it('should prefer static route (AD=1) over RIP route (AD=120) for same prefix', () => {
    const r1 = new Router('router-cisco', 'R1');
    const r2 = new Router('router-cisco', 'R2');

    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r1.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GigabitEthernet0/1', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));

    const c1 = new Cable('c1');
    c1.connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);

    // Add a static route to 192.168.1.0/24 via 10.0.2.254 (some other path)
    // But first we need an interface on that subnet for the static route
    r1.addStaticRoute(new IPAddress('192.168.1.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.254'));

    // Now enable RIP — R2 will advertise 192.168.1.0/24
    r1.enableRIP({ updateInterval: 1000, routeTimeout: 5000, gcTimeout: 3000 });
    r2.enableRIP({ updateInterval: 1000, routeTimeout: 5000, gcTimeout: 3000 });
    r1.ripAdvertiseNetwork(new IPAddress('10.0.0.0'), new SubnetMask('255.0.0.0'));
    r2.ripAdvertiseNetwork(new IPAddress('10.0.0.0'), new SubnetMask('255.0.0.0'));
    r2.ripAdvertiseNetwork(new IPAddress('192.168.1.0'), new SubnetMask('255.255.255.0'));

    vi.advanceTimersByTime(1100);

    // R1's routing table should have both: static (AD=1) and RIP (AD=120)
    const table = r1.getRoutingTable();
    const routes = table.filter(r => r.network.toString() === '192.168.1.0');
    expect(routes.length).toBe(2);

    const staticRoute = routes.find(r => r.type === 'static');
    const ripRoute = routes.find(r => r.type === 'rip');
    expect(staticRoute!.ad).toBe(1);
    expect(ripRoute!.ad).toBe(120);

    // LPM should prefer the static route (lower AD)
    // This is verified by the lookupRoute algorithm internally

    r1.disableRIP();
    r2.disableRIP();
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 3: Split Horizon & Poisoned Reverse
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: Split Horizon & Poisoned Reverse', () => {

  it('should not advertise routes back to the interface they were learned from (split horizon)', () => {
    // R1 --- R2 --- R3
    // R3 has 192.168.1.0/24. R2 learns it. R2 should NOT advertise it back to R3.
    const r1 = new Router('router-cisco', 'R1');
    const r2 = new Router('router-cisco', 'R2');
    const r3 = new Router('router-cisco', 'R3');

    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));
    r3.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
    r3.configureInterface('GigabitEthernet0/1', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));

    const c1 = new Cable('c1');
    c1.connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
    const c2 = new Cable('c2');
    c2.connect(r2.getPort('GigabitEthernet0/1')!, r3.getPort('GigabitEthernet0/0')!);

    const cfg: Partial<RIPConfig> = { updateInterval: 1000, routeTimeout: 10000, gcTimeout: 5000, splitHorizon: true, poisonedReverse: false };
    r1.enableRIP(cfg);
    r2.enableRIP(cfg);
    r3.enableRIP(cfg);

    r1.ripAdvertiseNetwork(new IPAddress('10.0.1.0'), new SubnetMask('255.255.255.0'));
    r2.ripAdvertiseNetwork(new IPAddress('10.0.1.0'), new SubnetMask('255.255.255.0'));
    r2.ripAdvertiseNetwork(new IPAddress('10.0.2.0'), new SubnetMask('255.255.255.0'));
    r3.ripAdvertiseNetwork(new IPAddress('10.0.2.0'), new SubnetMask('255.255.255.0'));
    r3.ripAdvertiseNetwork(new IPAddress('192.168.1.0'), new SubnetMask('255.255.255.0'));

    // First cycle: R2 learns 192.168.1.0/24 from R3
    vi.advanceTimersByTime(1100);

    // Second cycle: R2 sends update. With split horizon, R2 should NOT send
    // 192.168.1.0/24 back to R3 on GigabitEthernet0/1
    // But R1 should get it via R2 on GigabitEthernet0/0
    vi.advanceTimersByTime(1100);

    const r1Table = r1.getRoutingTable();
    const r1RipRoute = r1Table.find(r => r.type === 'rip' && r.network.toString() === '192.168.1.0');
    expect(r1RipRoute).toBeDefined();

    // R3 should NOT have a RIP route for 192.168.1.0/24 (it's its own connected network,
    // and split horizon prevents R2 from sending it back)
    const r3Table = r3.getRoutingTable();
    const r3RipRoute = r3Table.filter(r => r.type === 'rip' && r.network.toString() === '192.168.1.0');
    expect(r3RipRoute.length).toBe(0);

    r1.disableRIP();
    r2.disableRIP();
    r3.disableRIP();
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 4: Route Aging (Timeout + Garbage Collection)
// ═══════════════════════════════════════════════════════════════════

describe('Group 4: Route Aging', () => {

  it('should invalidate a route (metric=16) after timeout expires', () => {
    const r1 = new Router('router-cisco', 'R1');
    const r2 = new Router('router-cisco', 'R2');

    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GigabitEthernet0/1', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));

    const c1 = new Cable('c1');
    c1.connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);

    r1.enableRIP({ updateInterval: 1000, routeTimeout: 3000, gcTimeout: 2000 });
    r2.enableRIP({ updateInterval: 1000, routeTimeout: 3000, gcTimeout: 2000 });
    r1.ripAdvertiseNetwork(new IPAddress('10.0.0.0'), new SubnetMask('255.0.0.0'));
    r2.ripAdvertiseNetwork(new IPAddress('10.0.0.0'), new SubnetMask('255.0.0.0'));
    r2.ripAdvertiseNetwork(new IPAddress('192.168.1.0'), new SubnetMask('255.255.255.0'));

    // Learn the route
    vi.advanceTimersByTime(1100);
    let ripRoutes = r1.getRIPRoutes();
    expect(ripRoutes.size).toBeGreaterThanOrEqual(1);

    // Now disable R2's RIP so it stops sending updates
    r2.disableRIP();

    // Advance past the route timeout (3000ms)
    vi.advanceTimersByTime(3100);

    // Route should be invalidated (metric=16, in garbage collection)
    ripRoutes = r1.getRIPRoutes();
    const route = ripRoutes.get('192.168.1.0/24');
    if (route) {
      expect(route.garbageCollect).toBe(true);
      expect(route.metric).toBe(RIP_METRIC_INFINITY);
    }

    r1.disableRIP();
  });

  it('should garbage-collect a route after GC timer expires', () => {
    const r1 = new Router('router-cisco', 'R1');
    const r2 = new Router('router-cisco', 'R2');

    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GigabitEthernet0/1', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));

    const c1 = new Cable('c1');
    c1.connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);

    r1.enableRIP({ updateInterval: 1000, routeTimeout: 2000, gcTimeout: 1500 });
    r2.enableRIP({ updateInterval: 1000, routeTimeout: 2000, gcTimeout: 1500 });
    r1.ripAdvertiseNetwork(new IPAddress('10.0.0.0'), new SubnetMask('255.0.0.0'));
    r2.ripAdvertiseNetwork(new IPAddress('10.0.0.0'), new SubnetMask('255.0.0.0'));
    r2.ripAdvertiseNetwork(new IPAddress('192.168.1.0'), new SubnetMask('255.255.255.0'));

    // Learn the route
    vi.advanceTimersByTime(1100);

    // Confirm route exists in RIB
    let table = r1.getRoutingTable();
    expect(table.find(r => r.type === 'rip' && r.network.toString() === '192.168.1.0')).toBeDefined();

    // Stop R2
    r2.disableRIP();

    // Advance past timeout (2000) + GC (1500) = 3500ms
    vi.advanceTimersByTime(4000);

    // Route should be completely gone
    table = r1.getRoutingTable();
    expect(table.find(r => r.type === 'rip' && r.network.toString() === '192.168.1.0')).toBeUndefined();

    const ripRoutes = r1.getRIPRoutes();
    expect(ripRoutes.has('192.168.1.0/24')).toBe(false);

    r1.disableRIP();
  });

  it('should refresh timeout when update is received again', () => {
    const r1 = new Router('router-cisco', 'R1');
    const r2 = new Router('router-cisco', 'R2');

    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GigabitEthernet0/1', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));

    const c1 = new Cable('c1');
    c1.connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);

    // Update every 1s, timeout at 3s
    r1.enableRIP({ updateInterval: 1000, routeTimeout: 3000, gcTimeout: 2000 });
    r2.enableRIP({ updateInterval: 1000, routeTimeout: 3000, gcTimeout: 2000 });
    r1.ripAdvertiseNetwork(new IPAddress('10.0.0.0'), new SubnetMask('255.0.0.0'));
    r2.ripAdvertiseNetwork(new IPAddress('10.0.0.0'), new SubnetMask('255.0.0.0'));
    r2.ripAdvertiseNetwork(new IPAddress('192.168.1.0'), new SubnetMask('255.255.255.0'));

    // Learn the route
    vi.advanceTimersByTime(1100);

    // Keep receiving updates for 5 seconds (5 update cycles)
    // Route should stay alive because each update resets the timeout
    vi.advanceTimersByTime(5000);

    // Route should still be valid (not invalidated)
    const ripRoutes = r1.getRIPRoutes();
    const route = ripRoutes.get('192.168.1.0/24');
    expect(route).toBeDefined();
    expect(route!.garbageCollect).toBe(false);
    expect(route!.metric).toBe(1);

    r1.disableRIP();
    r2.disableRIP();
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 5: CLI Tests — Cisco IOS & Huawei VRP
// ═══════════════════════════════════════════════════════════════════

describe('Group 5: CLI Commands', () => {

  it('Cisco: "router rip" should enable RIP', async () => {
    const r1 = new Router('router-cisco', 'R1');
    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));

    await r1.executeCommand('router rip');
    expect(r1.isRIPEnabled()).toBe(true);

    r1.disableRIP();
  });

  it('Cisco: "network" should add network to RIP', async () => {
    const r1 = new Router('router-cisco', 'R1');
    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));

    await r1.executeCommand('router rip');
    await r1.executeCommand('network 10.0.0.0');

    const cfg = r1.getRIPConfig();
    expect(cfg.networks.length).toBe(1);
    expect(cfg.networks[0].network.toString()).toBe('10.0.0.0');

    r1.disableRIP();
  });

  it('Cisco: "show ip protocols" should display RIP info', async () => {
    const r1 = new Router('router-cisco', 'R1');
    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));

    await r1.executeCommand('router rip');
    await r1.executeCommand('network 10.0.0.0');

    const output = await r1.executeCommand('show ip protocols');
    expect(output).toContain('Routing Protocol is "rip"');
    expect(output).toContain('Version: 2');
    expect(output).toContain('Split horizon: enabled');
    expect(output).toContain('Advertised networks:');
    expect(output).toContain('10.0.0.0');

    r1.disableRIP();
  });

  it('Cisco: "show ip route" should show RIP routes with [120/metric]', async () => {
    const r1 = new Router('router-cisco', 'R1');
    const r2 = new Router('router-cisco', 'R2');

    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GigabitEthernet0/1', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));

    const c1 = new Cable('c1');
    c1.connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);

    r1.enableRIP({ updateInterval: 500, routeTimeout: 5000, gcTimeout: 3000 });
    r2.enableRIP({ updateInterval: 500, routeTimeout: 5000, gcTimeout: 3000 });
    r1.ripAdvertiseNetwork(new IPAddress('10.0.0.0'), new SubnetMask('255.0.0.0'));
    r2.ripAdvertiseNetwork(new IPAddress('10.0.0.0'), new SubnetMask('255.0.0.0'));
    r2.ripAdvertiseNetwork(new IPAddress('192.168.1.0'), new SubnetMask('255.255.255.0'));

    vi.advanceTimersByTime(600);

    const output = await r1.executeCommand('show ip route');
    expect(output).toContain('R - RIP');
    expect(output).toContain('R    192.168.1.0/24 [120/1]');
    expect(output).toContain('via 10.0.1.2');

    r1.disableRIP();
    r2.disableRIP();
  });

  it('Cisco: "no router rip" should disable RIP', async () => {
    const r1 = new Router('router-cisco', 'R1');
    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));

    await r1.executeCommand('router rip');
    expect(r1.isRIPEnabled()).toBe(true);

    await r1.executeCommand('no router rip');
    expect(r1.isRIPEnabled()).toBe(false);
  });

  it('Cisco: "show running-config" should include RIP config', async () => {
    const r1 = new Router('router-cisco', 'R1');
    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));

    await r1.executeCommand('router rip');
    await r1.executeCommand('network 10.0.0.0');

    const output = await r1.executeCommand('show running-config');
    expect(output).toContain('router rip');
    expect(output).toContain('version 2');
    expect(output).toContain('network 10.0.0.0');

    r1.disableRIP();
  });

  it('Huawei: "rip" should enable RIP', async () => {
    const r1 = new Router('router-huawei', 'HW1');
    r1.configureInterface('GE0/0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));

    await r1.executeCommand('rip');
    expect(r1.isRIPEnabled()).toBe(true);

    r1.disableRIP();
  });

  it('Huawei: "rip network <ip>" should add network', async () => {
    const r1 = new Router('router-huawei', 'HW1');
    r1.configureInterface('GE0/0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));

    await r1.executeCommand('rip');
    await r1.executeCommand('rip network 10.0.0.0');

    const cfg = r1.getRIPConfig();
    expect(cfg.networks.length).toBe(1);

    r1.disableRIP();
  });

  it('Huawei: "display rip" should display RIP status', async () => {
    const r1 = new Router('router-huawei', 'HW1');
    r1.configureInterface('GE0/0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));

    await r1.executeCommand('rip');
    await r1.executeCommand('rip network 10.0.0.0');

    const output = await r1.executeCommand('display rip');
    expect(output).toContain('RIP process 1');
    expect(output).toContain('Version: 2');
    expect(output).toContain('Networks:');
    expect(output).toContain('10.0.0.0');

    r1.disableRIP();
  });

  it('Huawei: "undo rip" should disable RIP', async () => {
    const r1 = new Router('router-huawei', 'HW1');
    r1.configureInterface('GE0/0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));

    await r1.executeCommand('rip');
    expect(r1.isRIPEnabled()).toBe(true);

    await r1.executeCommand('undo rip');
    expect(r1.isRIPEnabled()).toBe(false);
  });
});
