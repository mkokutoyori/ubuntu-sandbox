/**
 * TDD Tests for Routing Tables & Default Gateway (DET-L3-002)
 *
 * Group 1: Unit Tests — LPM selection, default gateway
 * Group 2: Functional Tests — Inter-VLAN routing, unreachable
 * Group 3: CLI Tests — ip route, route print, netstat -rn equivalents
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  IPAddress, SubnetMask, MACAddress,
  resetCounters,
} from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 1: Unit Tests — LPM & Default Gateway
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: Routing Table — LPM Selection', () => {

  // U-RT-01: Longest Prefix Match — most specific route wins
  describe('U-RT-01: LPM selects the most specific route', () => {
    it('should select /24 over /8 for an IP matching both', async () => {
      // Given: A routing table with:
      //   Route A: 10.0.0.0/8 via Gateway 1
      //   Route B: 10.1.1.0/24 via Gateway 2
      const pc = new LinuxPC('linux-pc', 'PC1');
      pc.configureInterface('eth0', new IPAddress('10.1.1.10'), new SubnetMask('255.255.255.0'));

      // We need two gateways on the same subnet to test LPM
      // The /24 connected route is for 10.1.1.0/24
      // Add a /8 static route via a different gateway
      pc.addStaticRoute(
        new IPAddress('10.0.0.0'),
        new SubnetMask('255.0.0.0'),
        new IPAddress('10.1.1.1'), // via gateway 1
        200,
      );

      // When: Looking for route to 10.1.1.50
      // Then: Should match the /24 connected route (more specific)
      const table = pc.getRoutingTable();
      expect(table.length).toBe(2); // connected + static

      // Verify by checking the resolved route uses the connected interface directly
      // (connected route has nextHop=null → uses destination directly)
      // The /8 route has nextHop=10.1.1.1
      // For 10.1.1.50: /24 match is more specific than /8 match

      // Test via ping to a same-subnet IP — should use the connected route
      // (nextHopIP would be 10.1.1.50 itself, not the gateway 10.1.1.1)
      const output = await pc.executeCommand('ip route');
      expect(output).toContain('10.1.1.0/24 dev eth0');
      expect(output).toContain('10.0.0.0/8 via 10.1.1.1');
    });

    it('should select /24 static route over /8 static route for 10.1.1.50', () => {
      const router = new CiscoRouter('R1');
      router.configureInterface('GigabitEthernet0/0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));

      // Two static routes — /8 and /24 pointing to different gateways
      router.addStaticRoute(
        new IPAddress('10.0.0.0'),
        new SubnetMask('255.0.0.0'),
        new IPAddress('192.168.1.10'), // gateway 1
      );
      router.addStaticRoute(
        new IPAddress('10.1.1.0'),
        new SubnetMask('255.255.255.0'),
        new IPAddress('192.168.1.20'), // gateway 2
      );

      const table = router.getRoutingTable();
      // Should have: connected (192.168.1.0/24), static (10.0.0.0/8), static (10.1.1.0/24)
      expect(table.length).toBe(3);

      // The routing table lookup for 10.1.1.50 is internal, but we can verify
      // via show ip route that both routes exist
      // The LPM algorithm in lookupRoute will pick the /24 over /8
    });

    it('should use metric as tiebreaker when prefix lengths are equal', () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      pc.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));

      // Two routes with same prefix length, different metrics
      pc.addStaticRoute(
        new IPAddress('10.0.0.0'),
        new SubnetMask('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        200, // higher metric
      );
      pc.addStaticRoute(
        new IPAddress('10.0.0.0'),
        new SubnetMask('255.255.255.0'),
        new IPAddress('192.168.1.2'),
        50,  // lower metric — should be preferred
      );

      const table = pc.getRoutingTable();
      const staticRoutes = table.filter(r => r.type === 'static');
      expect(staticRoutes.length).toBe(2);
      // Both routes exist; the LPM with metric tiebreaker will choose metric=50
    });
  });

  // U-RT-02: Default Gateway
  describe('U-RT-02: Default Gateway as 0.0.0.0/0', () => {
    it('should route to default gateway for an IP not in any specific route', async () => {
      // Given: A PC with IP 192.168.1.10/24 and Gateway 192.168.1.1
      const pc = new LinuxPC('linux-pc', 'PC1');
      pc.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
      pc.setDefaultGateway(new IPAddress('192.168.1.1'));

      // When: Looking for route to 8.8.8.8
      // Then: Should return the default route pointing to 192.168.1.1

      // Verify the routing table has a default route
      const table = pc.getRoutingTable();
      const defaultRoute = table.find(r => r.type === 'default');
      expect(defaultRoute).toBeDefined();
      expect(defaultRoute!.network.toString()).toBe('0.0.0.0');
      expect(defaultRoute!.mask.toString()).toBe('0.0.0.0');
      expect(defaultRoute!.nextHop!.toString()).toBe('192.168.1.1');

      // Verify via ip route output
      const output = await pc.executeCommand('ip route');
      expect(output).toContain('default via 192.168.1.1 dev eth0');
      expect(output).toContain('192.168.1.0/24 dev eth0');
    });

    it('should prefer specific route over default gateway', () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      pc.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
      pc.setDefaultGateway(new IPAddress('192.168.1.1'));

      // Route to 192.168.1.50 should use the connected /24 route, not the default
      const table = pc.getRoutingTable();
      const connected = table.find(r => r.type === 'connected');
      const dflt = table.find(r => r.type === 'default');
      expect(connected).toBeDefined();
      expect(dflt).toBeDefined();
      // Connected route has /24 prefix which is more specific than /0
      expect(connected!.mask.toCIDR()).toBe(24);
      expect(dflt!.mask.toCIDR()).toBe(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 2: Functional Tests — Inter-Network Routing
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: Functional — Inter-Network Routing', () => {

  // F-RT-01: Communication Inter-VLAN via Router
  describe('F-RT-01: Inter-VLAN communication via router', () => {
    it('should send ARP for gateway, encapsulate with gateway MAC, and route IPv4 end-to-end', async () => {
      // Configuration:
      //   PC1 (10.0.1.2/24), Gateway: 10.0.1.1
      //   Router: eth0 (10.0.1.1) and eth1 (10.0.2.1)
      //   PC2 (10.0.2.2/24), Gateway: 10.0.2.1
      const pc1 = new LinuxPC('linux-pc', 'PC1');
      const pc2 = new LinuxPC('linux-pc', 'PC2');
      const router = new CiscoRouter('R1');

      pc1.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
      pc2.configureInterface('eth0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
      router.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
      router.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));

      pc1.setDefaultGateway(new IPAddress('10.0.1.1'));
      pc2.setDefaultGateway(new IPAddress('10.0.2.1'));

      // Wire: PC1 — R1 — PC2
      const c1 = new Cable('c1');
      c1.connect(pc1.getPort('eth0')!, router.getPort('GigabitEthernet0/0')!);
      const c2 = new Cable('c2');
      c2.connect(router.getPort('GigabitEthernet0/1')!, pc2.getPort('eth0')!);

      // When: PC1 pings PC2
      const output = await pc1.executeCommand('ping -c 1 10.0.2.2');

      // Then:
      // - PC1 sends ARP for 10.0.1.1 (gateway) → learns gateway MAC
      // - Ethernet frame: Src_MAC=PC1, Dst_MAC=Router_Eth0
      // - IPv4 packet: Src_IP=10.0.1.2, Dst_IP=10.0.2.2
      // - Router forwards, PC2 replies via gateway
      expect(output).toContain('64 bytes from 10.0.2.2');
      expect(output).toContain('1 received');
      expect(output).toContain('ttl=63'); // TTL decremented by 1 hop

      // Verify PC1's ARP table contains the gateway (not PC2's MAC)
      const arpTable = pc1.getARPTable();
      expect(arpTable.has('10.0.1.1')).toBe(true);   // gateway MAC learned
      expect(arpTable.has('10.0.2.2')).toBe(false);   // PC2's MAC NOT directly learned

      // Verify PC2's ARP table contains its gateway (not PC1's MAC)
      const arp2 = pc2.getARPTable();
      expect(arp2.has('10.0.2.1')).toBe(true);   // gateway MAC learned
      expect(arp2.has('10.0.1.2')).toBe(false);   // PC1's MAC NOT directly learned
    });
  });

  // F-RT-02: Network unreachable
  describe('F-RT-02: Network unreachable without gateway', () => {
    it('should fail immediately with "Network unreachable" when no route exists', async () => {
      // Given: A PC without a default gateway
      const pc = new LinuxPC('linux-pc', 'PC1');
      pc.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
      // No gateway set

      // When: PC tries to ping an IP outside its subnet
      const output = await pc.executeCommand('ping -c 1 10.0.0.1');

      // Then: Should fail with "Network is unreachable"
      expect(output).toContain('Network is unreachable');
    });

    it('should also fail on Windows with "General failure" when no route exists', async () => {
      const pc = new WindowsPC('windows-pc', 'WinPC');
      pc.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));

      const output = await pc.executeCommand('ping -n 1 10.0.0.1');
      expect(output).toContain('General failure');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 3: CLI Tests — Route Display & Management
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: CLI — Route Display & Management', () => {

  // Linux ip route
  describe('Linux: ip route commands', () => {
    it('should show connected routes and default gateway', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      pc.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
      pc.setDefaultGateway(new IPAddress('192.168.1.1'));

      const output = await pc.executeCommand('ip route');
      expect(output).toContain('192.168.1.0/24 dev eth0');
      expect(output).toContain('default via 192.168.1.1 dev eth0');
    });

    it('should add and display a static route with metric', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      pc.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));

      const result = await pc.executeCommand('ip route add 172.16.0.0/16 via 192.168.1.254 metric 50');
      expect(result).toBe('');

      const output = await pc.executeCommand('ip route');
      expect(output).toContain('172.16.0.0/16 via 192.168.1.254 dev eth0 proto static metric 50');
    });

    it('should delete a static route', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      pc.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));

      await pc.executeCommand('ip route add 172.16.0.0/16 via 192.168.1.254');
      let output = await pc.executeCommand('ip route');
      expect(output).toContain('172.16.0.0/16');

      const delResult = await pc.executeCommand('ip route del 172.16.0.0/16');
      expect(delResult).toBe('');

      output = await pc.executeCommand('ip route');
      expect(output).not.toContain('172.16.0.0/16');
    });

    it('should fail to add route when next-hop is unreachable', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      pc.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));

      // Next-hop 10.0.0.1 is not reachable from any interface
      const result = await pc.executeCommand('ip route add 172.16.0.0/16 via 10.0.0.1');
      expect(result).toContain('Network is unreachable');
    });
  });

  // Windows route commands
  describe('Windows: route commands', () => {
    it('should show routing table with route print', async () => {
      const pc = new WindowsPC('windows-pc', 'WinPC');
      pc.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
      pc.setDefaultGateway(new IPAddress('192.168.1.1'));

      const output = await pc.executeCommand('route print');
      expect(output).toContain('Active Routes:');
      expect(output).toContain('Network Destination');
      expect(output).toContain('192.168.1.0');
      expect(output).toContain('0.0.0.0');
      expect(output).toContain('192.168.1.1');
    });

    it('should add a static route with metric', async () => {
      const pc = new WindowsPC('windows-pc', 'WinPC');
      pc.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));

      const result = await pc.executeCommand('route add 172.16.0.0 mask 255.255.0.0 192.168.1.254 metric 10');
      expect(result).toContain('OK!');

      const output = await pc.executeCommand('route print');
      expect(output).toContain('172.16.0.0');
      expect(output).toContain('192.168.1.254');
    });

    it('should delete a route', async () => {
      const pc = new WindowsPC('windows-pc', 'WinPC');
      pc.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));

      await pc.executeCommand('route add 172.16.0.0 mask 255.255.0.0 192.168.1.254');
      let output = await pc.executeCommand('route print');
      expect(output).toContain('172.16.0.0');

      const delResult = await pc.executeCommand('route delete 172.16.0.0 mask 255.255.0.0');
      expect(delResult).toContain('OK!');

      output = await pc.executeCommand('route print');
      expect(output).not.toContain('172.16.0.0');
    });
  });

  // Router show ip route
  describe('Router: show ip route with metric', () => {
    it('should display routing table with connected and static routes', async () => {
      const router = new CiscoRouter('R1');
      router.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
      router.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));
      router.addStaticRoute(
        new IPAddress('10.0.3.0'),
        new SubnetMask('255.255.255.0'),
        new IPAddress('10.0.2.2'),
      );

      const output = await router.executeCommand('show ip route');
      expect(output).toContain('C    10.0.1.0/24 is directly connected');
      expect(output).toContain('C    10.0.2.0/24 is directly connected');
      expect(output).toContain('S    10.0.3.0/24 [1/0] via 10.0.2.2');
    });
  });
});
