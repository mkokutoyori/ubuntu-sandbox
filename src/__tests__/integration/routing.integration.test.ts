/**
 * Integration tests for routing
 * Tests interaction between PCs, Switches, and Router
 *
 * Scenarios covered:
 * 1. PC-to-PC communication through router (different subnets)
 * 2. Router forwarding with static routes
 * 3. TTL decrement during forwarding
 * 4. Default route usage
 * 5. Multi-hop routing
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PC } from '@/domain/devices/PC';
import { Switch } from '@/domain/devices/Switch';
import { Router } from '@/domain/devices/Router';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';
import { SubnetMask } from '@/domain/network/value-objects/SubnetMask';
import { MACAddress } from '@/domain/network/value-objects/MACAddress';
import { EthernetFrame, EtherType } from '@/domain/network/entities/EthernetFrame';
import { IPv4Packet } from '@/domain/network/entities/IPv4Packet';

describe('Routing Integration Tests', () => {
  describe('Scenario 1: Simple routing between two subnets', () => {
    let pc1: PC;
    let pc2: PC;
    let router: Router;

    beforeEach(() => {
      // Topology:
      // PC1 (192.168.1.10/24) -- eth0 <-> eth0 Router eth1 <-> eth0 -- PC2 (192.168.2.10/24)

      pc1 = new PC('pc1', 'PC 1');
      pc2 = new PC('pc2', 'PC 2');
      router = new Router('r1', 'Router 1', 2);

      // Configure PC1 in subnet 192.168.1.0/24
      pc1.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      pc1.setGateway(new IPAddress('192.168.1.1'));

      // Configure PC2 in subnet 192.168.2.0/24
      pc2.setIPAddress('eth0', new IPAddress('192.168.2.10'), new SubnetMask('/24'));
      pc2.setGateway(new IPAddress('192.168.2.1'));

      // Configure router interfaces
      router.setIPAddress('eth0', new IPAddress('192.168.1.1'), new SubnetMask('/24'));
      router.setIPAddress('eth1', new IPAddress('192.168.2.1'), new SubnetMask('/24'));

      // Power on devices
      pc1.powerOn();
      pc2.powerOn();
      router.powerOn();

      // Set up ARP entries (simulating ARP resolution)
      pc1.addARPEntry(new IPAddress('192.168.1.1'), router.getInterface('eth0')!.getMAC());
      pc2.addARPEntry(new IPAddress('192.168.2.1'), router.getInterface('eth1')!.getMAC());
      router.addARPEntry('eth0', new IPAddress('192.168.1.10'), pc1.getInterface('eth0')!.getMAC());
      router.addARPEntry('eth1', new IPAddress('192.168.2.10'), pc2.getInterface('eth0')!.getMAC());

      // Connect PC1 <-> Router eth0
      pc1.onFrameTransmit((frame) => {
        router.receiveFrame('eth0', frame);
      });

      // Connect PC2 <-> Router eth1
      pc2.onFrameTransmit((frame) => {
        router.receiveFrame('eth1', frame);
      });

      // Connect Router -> PCs
      router.onFrameTransmit((iface, frame) => {
        if (iface === 'eth0') {
          pc1.receiveFrame('eth0', frame);
        } else if (iface === 'eth1') {
          pc2.receiveFrame('eth0', frame);
        }
      });
    });

    it('should have directly connected routes', () => {
      const routes = router.getRoutes();

      expect(routes.length).toBe(2);

      const route1 = routes.find(r => r.network.equals(new IPAddress('192.168.1.0')));
      expect(route1).toBeDefined();
      expect(route1!.isDirectlyConnected).toBe(true);
      expect(route1!.interface).toBe('eth0');

      const route2 = routes.find(r => r.network.equals(new IPAddress('192.168.2.0')));
      expect(route2).toBeDefined();
      expect(route2!.isDirectlyConnected).toBe(true);
      expect(route2!.interface).toBe('eth1');
    });

    it('should lookup correct route for each subnet', () => {
      const route1 = router.lookupRoute(new IPAddress('192.168.1.10'));
      expect(route1).toBeDefined();
      expect(route1!.interface).toBe('eth0');

      const route2 = router.lookupRoute(new IPAddress('192.168.2.10'));
      expect(route2).toBeDefined();
      expect(route2!.interface).toBe('eth1');
    });

    it('should forward packet from PC1 to PC2 through router', () => {
      let pc2ReceivedPacket: IPv4Packet | undefined;

      pc2.onFrameReceive((frame) => {
        if (frame.getEtherType() === EtherType.IPv4) {
          pc2ReceivedPacket = IPv4Packet.fromBytes(frame.getPayload());
        }
      });

      // Create IP packet from PC1 to PC2
      const packet = new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.10'),
        destinationIP: new IPAddress('192.168.2.10'),
        protocol: 6, // TCP
        ttl: 64,
        payload: Buffer.alloc(20)
      });

      // Encapsulate in Ethernet frame to router's MAC
      const packetBytes = packet.toBytes();
      const paddedPayload = Buffer.concat([
        packetBytes,
        Buffer.alloc(Math.max(0, 46 - packetBytes.length))
      ]);

      const frame = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: router.getInterface('eth0')!.getMAC(),
        etherType: EtherType.IPv4,
        payload: paddedPayload
      });

      // PC1 sends frame to router
      pc1.sendFrame('eth0', frame);

      // PC2 should receive the packet
      expect(pc2ReceivedPacket).toBeDefined();
      expect(pc2ReceivedPacket!.getSourceIP().equals(new IPAddress('192.168.1.10'))).toBe(true);
      expect(pc2ReceivedPacket!.getDestinationIP().equals(new IPAddress('192.168.2.10'))).toBe(true);
      expect(pc2ReceivedPacket!.getTTL()).toBe(63); // TTL decremented
    });

    it('should track forwarding statistics', () => {
      const packet = new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.10'),
        destinationIP: new IPAddress('192.168.2.10'),
        protocol: 6,
        ttl: 64,
        payload: Buffer.alloc(20)
      });

      const packetBytes = packet.toBytes();
      const paddedPayload = Buffer.concat([
        packetBytes,
        Buffer.alloc(Math.max(0, 46 - packetBytes.length))
      ]);

      const frame = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: router.getInterface('eth0')!.getMAC(),
        etherType: EtherType.IPv4,
        payload: paddedPayload
      });

      pc1.sendFrame('eth0', frame);

      const stats = router.getStatistics();
      expect(stats.packetsReceived).toBe(1);
      expect(stats.packetsForwarded).toBe(1);
      expect(stats.packetsDropped).toBe(0);
    });
  });

  describe('Scenario 2: Static routes', () => {
    let pc1: PC;
    let pc2: PC;
    let router1: Router;
    let router2: Router;

    beforeEach(() => {
      // Topology:
      // PC1 (10.0.1.10/24) -- R1 (10.0.1.1 <-> 10.0.2.1) -- R2 (10.0.2.2 <-> 10.0.3.1) -- PC2 (10.0.3.10/24)

      pc1 = new PC('pc1', 'PC 1');
      pc2 = new PC('pc2', 'PC 2');
      router1 = new Router('r1', 'Router 1', 2);
      router2 = new Router('r2', 'Router 2', 2);

      // Configure PC1
      pc1.setIPAddress('eth0', new IPAddress('10.0.1.10'), new SubnetMask('/24'));
      pc1.setGateway(new IPAddress('10.0.1.1'));

      // Configure PC2
      pc2.setIPAddress('eth0', new IPAddress('10.0.3.10'), new SubnetMask('/24'));
      pc2.setGateway(new IPAddress('10.0.3.1'));

      // Configure Router 1
      router1.setIPAddress('eth0', new IPAddress('10.0.1.1'), new SubnetMask('/24'));
      router1.setIPAddress('eth1', new IPAddress('10.0.2.1'), new SubnetMask('/24'));

      // Configure Router 2
      router2.setIPAddress('eth0', new IPAddress('10.0.2.2'), new SubnetMask('/24'));
      router2.setIPAddress('eth1', new IPAddress('10.0.3.1'), new SubnetMask('/24'));

      // Add static routes
      router1.addRoute(
        new IPAddress('10.0.3.0'),
        new SubnetMask('/24'),
        new IPAddress('10.0.2.2'),
        'eth1'
      );

      router2.addRoute(
        new IPAddress('10.0.1.0'),
        new SubnetMask('/24'),
        new IPAddress('10.0.2.1'),
        'eth0'
      );

      // Power on
      pc1.powerOn();
      pc2.powerOn();
      router1.powerOn();
      router2.powerOn();

      // Set up ARP entries
      pc1.addARPEntry(new IPAddress('10.0.1.1'), router1.getInterface('eth0')!.getMAC());
      router1.addARPEntry('eth0', new IPAddress('10.0.1.10'), pc1.getInterface('eth0')!.getMAC());
      router1.addARPEntry('eth1', new IPAddress('10.0.2.2'), router2.getInterface('eth0')!.getMAC());
      router2.addARPEntry('eth0', new IPAddress('10.0.2.1'), router1.getInterface('eth1')!.getMAC());
      router2.addARPEntry('eth1', new IPAddress('10.0.3.10'), pc2.getInterface('eth0')!.getMAC());
      pc2.addARPEntry(new IPAddress('10.0.3.1'), router2.getInterface('eth1')!.getMAC());

      // Connect topology
      pc1.onFrameTransmit((frame) => router1.receiveFrame('eth0', frame));
      pc2.onFrameTransmit((frame) => router2.receiveFrame('eth1', frame));

      router1.onFrameTransmit((iface, frame) => {
        if (iface === 'eth0') pc1.receiveFrame('eth0', frame);
        if (iface === 'eth1') router2.receiveFrame('eth0', frame);
      });

      router2.onFrameTransmit((iface, frame) => {
        if (iface === 'eth0') router1.receiveFrame('eth1', frame);
        if (iface === 'eth1') pc2.receiveFrame('eth0', frame);
      });
    });

    it('should have static routes configured', () => {
      const r1Routes = router1.getRoutes();
      const staticRoute = r1Routes.find(r => r.network.equals(new IPAddress('10.0.3.0')));

      expect(staticRoute).toBeDefined();
      expect(staticRoute!.isDirectlyConnected).toBe(false);
      expect(staticRoute!.nextHop!.equals(new IPAddress('10.0.2.2'))).toBe(true);
    });

    it('should forward packet through multiple routers', () => {
      let pc2ReceivedPacket: IPv4Packet | undefined;

      pc2.onFrameReceive((frame) => {
        if (frame.getEtherType() === EtherType.IPv4) {
          pc2ReceivedPacket = IPv4Packet.fromBytes(frame.getPayload());
        }
      });

      // Create packet from PC1 to PC2
      const packet = new IPv4Packet({
        sourceIP: new IPAddress('10.0.1.10'),
        destinationIP: new IPAddress('10.0.3.10'),
        protocol: 1, // ICMP
        ttl: 64,
        payload: Buffer.alloc(20)
      });

      const packetBytes = packet.toBytes();
      const paddedPayload = Buffer.concat([
        packetBytes,
        Buffer.alloc(Math.max(0, 46 - packetBytes.length))
      ]);

      const frame = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: router1.getInterface('eth0')!.getMAC(),
        etherType: EtherType.IPv4,
        payload: paddedPayload
      });

      pc1.sendFrame('eth0', frame);

      expect(pc2ReceivedPacket).toBeDefined();
      expect(pc2ReceivedPacket!.getTTL()).toBe(62); // Decremented twice (2 hops)
    });
  });

  describe('Scenario 3: TTL expiration', () => {
    let pc1: PC;
    let pc2: PC;
    let router: Router;

    beforeEach(() => {
      pc1 = new PC('pc1', 'PC 1');
      pc2 = new PC('pc2', 'PC 2');
      router = new Router('r1', 'Router 1', 2);

      pc1.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      pc2.setIPAddress('eth0', new IPAddress('192.168.2.10'), new SubnetMask('/24'));
      router.setIPAddress('eth0', new IPAddress('192.168.1.1'), new SubnetMask('/24'));
      router.setIPAddress('eth1', new IPAddress('192.168.2.1'), new SubnetMask('/24'));

      pc1.powerOn();
      pc2.powerOn();
      router.powerOn();

      // Connect
      pc1.onFrameTransmit((frame) => router.receiveFrame('eth0', frame));
    });

    it('should drop packet with TTL = 1', () => {
      let dropReason: string | undefined;

      router.onPacketDrop((reason) => {
        dropReason = reason;
      });

      const packet = new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.10'),
        destinationIP: new IPAddress('192.168.2.10'),
        protocol: 1,
        ttl: 1, // Will expire
        payload: Buffer.alloc(20)
      });

      const packetBytes = packet.toBytes();
      const paddedPayload = Buffer.concat([
        packetBytes,
        Buffer.alloc(Math.max(0, 46 - packetBytes.length))
      ]);

      const frame = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: router.getInterface('eth0')!.getMAC(),
        etherType: EtherType.IPv4,
        payload: paddedPayload
      });

      pc1.sendFrame('eth0', frame);

      expect(dropReason).toBe('TTL expired');

      const stats = router.getStatistics();
      expect(stats.ttlExpired).toBe(1);
      expect(stats.packetsDropped).toBe(1);
      expect(stats.packetsForwarded).toBe(0);
    });
  });

  describe('Scenario 4: Default route', () => {
    let pc1: PC;
    let router: Router;

    beforeEach(() => {
      pc1 = new PC('pc1', 'PC 1');
      router = new Router('r1', 'Router 1', 2);

      pc1.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      router.setIPAddress('eth0', new IPAddress('192.168.1.1'), new SubnetMask('/24'));
      router.setIPAddress('eth1', new IPAddress('10.0.0.1'), new SubnetMask('/24'));

      // Set default route (0.0.0.0/0)
      router.setDefaultRoute(new IPAddress('10.0.0.2'), 'eth1');

      pc1.powerOn();
      router.powerOn();

      pc1.addARPEntry(new IPAddress('192.168.1.1'), router.getInterface('eth0')!.getMAC());
      router.addARPEntry('eth1', new IPAddress('10.0.0.2'), new MACAddress('AA:BB:CC:DD:EE:FF'));

      pc1.onFrameTransmit((frame) => router.receiveFrame('eth0', frame));
    });

    it('should use default route for unknown destinations', () => {
      let forwardedInterface: string | undefined;

      router.onPacketForward((iface) => {
        forwardedInterface = iface;
      });

      // Packet to unknown destination (should use default route)
      const packet = new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.10'),
        destinationIP: new IPAddress('8.8.8.8'), // Unknown destination
        protocol: 1,
        ttl: 64,
        payload: Buffer.alloc(20)
      });

      const packetBytes = packet.toBytes();
      const paddedPayload = Buffer.concat([
        packetBytes,
        Buffer.alloc(Math.max(0, 46 - packetBytes.length))
      ]);

      const frame = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: router.getInterface('eth0')!.getMAC(),
        etherType: EtherType.IPv4,
        payload: paddedPayload
      });

      pc1.sendFrame('eth0', frame);

      expect(forwardedInterface).toBe('eth1'); // Forwarded via default route
    });

    it('should prefer specific route over default', () => {
      // Add specific route
      router.addRoute(
        new IPAddress('172.16.0.0'),
        new SubnetMask('/16'),
        new IPAddress('10.0.0.3'),
        'eth1'
      );

      let forwardedInterface: string | undefined;

      router.onPacketForward((iface) => {
        forwardedInterface = iface;
      });

      // Packet to 172.16.x.x should use specific route
      const packet = new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.10'),
        destinationIP: new IPAddress('172.16.5.10'),
        protocol: 1,
        ttl: 64,
        payload: Buffer.alloc(20)
      });

      const packetBytes = packet.toBytes();
      const paddedPayload = Buffer.concat([
        packetBytes,
        Buffer.alloc(Math.max(0, 46 - packetBytes.length))
      ]);

      const frame = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: router.getInterface('eth0')!.getMAC(),
        etherType: EtherType.IPv4,
        payload: paddedPayload
      });

      pc1.sendFrame('eth0', frame);

      expect(forwardedInterface).toBe('eth1');

      // Check that specific route was used (not default)
      const route = router.lookupRoute(new IPAddress('172.16.5.10'));
      expect(route!.mask.getCIDR()).toBe(16); // More specific than /0
    });
  });

  describe('Scenario 5: Longest prefix match', () => {
    let router: Router;

    beforeEach(() => {
      router = new Router('r1', 'Router 1', 3);

      router.setIPAddress('eth0', new IPAddress('10.0.0.1'), new SubnetMask('/24'));
      router.setIPAddress('eth1', new IPAddress('192.168.1.1'), new SubnetMask('/24'));
      router.setIPAddress('eth2', new IPAddress('172.16.1.1'), new SubnetMask('/24'));

      // Add overlapping routes
      router.addRoute(
        new IPAddress('172.16.0.0'),
        new SubnetMask('/16'), // Less specific
        new IPAddress('10.0.0.2'),
        'eth0'
      );

      router.addRoute(
        new IPAddress('172.16.5.0'),
        new SubnetMask('/24'), // More specific
        new IPAddress('192.168.1.2'),
        'eth1'
      );

      router.powerOn();
    });

    it('should use most specific matching route', () => {
      // 172.16.5.10 matches both /16 and /24, but /24 is more specific
      const route = router.lookupRoute(new IPAddress('172.16.5.10'));

      expect(route).toBeDefined();
      expect(route!.mask.getCIDR()).toBe(24); // More specific route
      expect(route!.interface).toBe('eth1');
      expect(route!.nextHop!.equals(new IPAddress('192.168.1.2'))).toBe(true);
    });

    it('should use less specific route when more specific does not match', () => {
      // 172.16.10.10 matches /16 but not /24
      const route = router.lookupRoute(new IPAddress('172.16.10.10'));

      expect(route).toBeDefined();
      expect(route!.mask.getCIDR()).toBe(16);
      expect(route!.interface).toBe('eth0');
    });
  });
});
