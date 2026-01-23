/**
 * Unit tests for Router device
 * Following TDD approach - tests written first
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Router } from '@/domain/devices/Router';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';
import { SubnetMask } from '@/domain/network/value-objects/SubnetMask';
import { MACAddress } from '@/domain/network/value-objects/MACAddress';
import { EthernetFrame, EtherType } from '@/domain/network/entities/EthernetFrame';
import { IPv4Packet, IPProtocol } from '@/domain/network/entities/IPv4Packet';

describe('Router', () => {
  let router: Router;

  beforeEach(() => {
    router = new Router('r1', 'Router 1', 4); // 4 interfaces
  });

  describe('construction', () => {
    it('should create router with id, name, and interfaces', () => {
      expect(router.getId()).toBe('r1');
      expect(router.getName()).toBe('Router 1');
      expect(router.getType()).toBe('router');
    });

    it('should have specified number of interfaces', () => {
      expect(router.hasInterface('eth0')).toBe(true);
      expect(router.hasInterface('eth1')).toBe(true);
      expect(router.hasInterface('eth2')).toBe(true);
      expect(router.hasInterface('eth3')).toBe(true);
    });

    it('should create 2 interfaces by default', () => {
      const r2 = new Router('r2', 'Router 2');
      expect(r2.hasInterface('eth0')).toBe(true);
      expect(r2.hasInterface('eth1')).toBe(true);
    });
  });

  describe('power management', () => {
    it('should power on router', () => {
      router.powerOn();

      expect(router.getStatus()).toBe('online');
      expect(router.isOnline()).toBe(true);
    });

    it('should bring up interfaces when powered on', () => {
      router.powerOn();

      const iface = router.getInterface('eth0');
      expect(iface!.isUp()).toBe(true);
    });

    it('should power off router', () => {
      router.powerOn();
      router.powerOff();

      expect(router.getStatus()).toBe('offline');
    });

    it('should reset router and clear routing table', () => {
      router.powerOn();
      router.addRoute(new IPAddress('192.168.1.0'), new SubnetMask('/24'), new IPAddress('10.0.0.1'), 'eth0');

      router.reset();

      expect(router.getStatus()).toBe('online');
      const routes = router.getRoutes();
      expect(routes.filter(r => !r.isDirectlyConnected)).toHaveLength(0);
    });
  });

  describe('interface configuration', () => {
    beforeEach(() => {
      router.powerOn();
    });

    it('should configure IP on interface', () => {
      const ip = new IPAddress('10.0.0.1');
      const mask = new SubnetMask('/24');

      router.setIPAddress('eth0', ip, mask);

      const iface = router.getInterface('eth0');
      expect(iface!.getIPAddress()?.equals(ip)).toBe(true);
      expect(iface!.getSubnetMask()?.equals(mask)).toBe(true);
    });

    it('should add directly connected route when IP configured', () => {
      router.setIPAddress('eth0', new IPAddress('10.0.0.1'), new SubnetMask('/24'));

      const routes = router.getRoutes();
      const directRoute = routes.find(r =>
        r.network.toString() === '10.0.0.0' && r.isDirectlyConnected
      );

      expect(directRoute).toBeDefined();
      expect(directRoute!.interface).toBe('eth0');
    });

    it('should configure multiple interfaces', () => {
      router.setIPAddress('eth0', new IPAddress('10.0.0.1'), new SubnetMask('/24'));
      router.setIPAddress('eth1', new IPAddress('192.168.1.1'), new SubnetMask('/24'));

      expect(router.getInterface('eth0')!.getIPAddress()?.toString()).toBe('10.0.0.1');
      expect(router.getInterface('eth1')!.getIPAddress()?.toString()).toBe('192.168.1.1');
    });
  });

  describe('routing table', () => {
    beforeEach(() => {
      router.powerOn();
      router.setIPAddress('eth0', new IPAddress('10.0.0.1'), new SubnetMask('/24'));
      router.setIPAddress('eth1', new IPAddress('192.168.1.1'), new SubnetMask('/24'));
    });

    it('should add static route', () => {
      router.addRoute(
        new IPAddress('172.16.0.0'),
        new SubnetMask('/16'),
        new IPAddress('10.0.0.2'),
        'eth0'
      );

      const routes = router.getRoutes();
      const staticRoute = routes.find(r => r.network.toString() === '172.16.0.0');

      expect(staticRoute).toBeDefined();
      expect(staticRoute!.nextHop?.toString()).toBe('10.0.0.2');
      expect(staticRoute!.interface).toBe('eth0');
    });

    it('should add default route', () => {
      router.setDefaultRoute(new IPAddress('10.0.0.254'), 'eth0');

      const routes = router.getRoutes();
      const defaultRoute = routes.find(r => r.network.toString() === '0.0.0.0');

      expect(defaultRoute).toBeDefined();
      expect(defaultRoute!.mask.getCIDR()).toBe(0);
    });

    it('should remove route', () => {
      router.addRoute(
        new IPAddress('172.16.0.0'),
        new SubnetMask('/16'),
        new IPAddress('10.0.0.2'),
        'eth0'
      );

      router.removeRoute(new IPAddress('172.16.0.0'), new SubnetMask('/16'));

      const routes = router.getRoutes();
      const removedRoute = routes.find(r => r.network.toString() === '172.16.0.0');
      expect(removedRoute).toBeUndefined();
    });

    it('should lookup route for destination', () => {
      router.addRoute(
        new IPAddress('172.16.0.0'),
        new SubnetMask('/16'),
        new IPAddress('10.0.0.2'),
        'eth0'
      );

      const route = router.lookupRoute(new IPAddress('172.16.5.10'));

      expect(route).toBeDefined();
      expect(route!.network.toString()).toBe('172.16.0.0');
    });

    it('should use most specific route (longest prefix match)', () => {
      router.addRoute(new IPAddress('172.16.0.0'), new SubnetMask('/16'), new IPAddress('10.0.0.2'), 'eth0');
      router.addRoute(new IPAddress('172.16.5.0'), new SubnetMask('/24'), new IPAddress('10.0.0.3'), 'eth0');

      const route = router.lookupRoute(new IPAddress('172.16.5.10'));

      expect(route!.network.toString()).toBe('172.16.5.0');
      expect(route!.mask.getCIDR()).toBe(24);
    });

    it('should return undefined for unreachable destination', () => {
      const route = router.lookupRoute(new IPAddress('8.8.8.8'));

      expect(route).toBeUndefined();
    });
  });

  describe('IP forwarding', () => {
    beforeEach(() => {
      router.powerOn();
      router.setIPAddress('eth0', new IPAddress('10.0.0.1'), new SubnetMask('/24'));
      router.setIPAddress('eth1', new IPAddress('192.168.1.1'), new SubnetMask('/24'));
    });

    it('should forward packet to next hop', () => {
      router.addRoute(
        new IPAddress('192.168.2.0'),
        new SubnetMask('/24'),
        new IPAddress('192.168.1.2'),
        'eth1'
      );

      let forwardedPacket: IPv4Packet | undefined;
      let forwardedInterface: string | undefined;

      router.onPacketForward((iface, packet) => {
        forwardedInterface = iface;
        forwardedPacket = packet;
      });

      const packet = new IPv4Packet({
        sourceIP: new IPAddress('10.0.0.10'),
        destinationIP: new IPAddress('192.168.2.10'),
        protocol: IPProtocol.TCP,
        ttl: 64,
        payload: Buffer.from([0x00, 0x01])
      });

      router.forwardPacket(packet, 'eth0');

      expect(forwardedInterface).toBe('eth1');
      expect(forwardedPacket).toBeDefined();
      expect(forwardedPacket!.getTTL()).toBe(63); // TTL decremented
    });

    it('should drop packet with TTL = 1', () => {
      let dropped = false;

      router.onPacketDrop((reason) => {
        dropped = true;
        expect(reason).toContain('TTL');
      });

      const packet = new IPv4Packet({
        sourceIP: new IPAddress('10.0.0.10'),
        destinationIP: new IPAddress('192.168.1.10'),
        protocol: IPProtocol.TCP,
        ttl: 1,
        payload: Buffer.from([0x00, 0x01])
      });

      router.forwardPacket(packet, 'eth0');

      expect(dropped).toBe(true);
    });

    it('should drop packet with no route', () => {
      let dropped = false;

      router.onPacketDrop((reason) => {
        dropped = true;
        expect(reason).toContain('No route');
      });

      const packet = new IPv4Packet({
        sourceIP: new IPAddress('10.0.0.10'),
        destinationIP: new IPAddress('8.8.8.8'),
        protocol: IPProtocol.TCP,
        ttl: 64,
        payload: Buffer.from([0x00, 0x01])
      });

      router.forwardPacket(packet, 'eth0');

      expect(dropped).toBe(true);
    });

    it('should deliver packet to directly connected network', () => {
      let forwardedInterface: string | undefined;

      router.onPacketForward((iface, packet) => {
        forwardedInterface = iface;
      });

      const packet = new IPv4Packet({
        sourceIP: new IPAddress('10.0.0.10'),
        destinationIP: new IPAddress('192.168.1.10'),
        protocol: IPProtocol.TCP,
        ttl: 64,
        payload: Buffer.from([0x00, 0x01])
      });

      router.forwardPacket(packet, 'eth0');

      expect(forwardedInterface).toBe('eth1');
    });
  });

  describe('ARP resolution', () => {
    beforeEach(() => {
      router.powerOn();
      router.setIPAddress('eth0', new IPAddress('10.0.0.1'), new SubnetMask('/24'));
    });

    it('should resolve next hop MAC via ARP', () => {
      const nextHopIP = new IPAddress('10.0.0.2');
      const nextHopMAC = new MACAddress('AA:BB:CC:DD:EE:FF');

      router.addARPEntry('eth0', nextHopIP, nextHopMAC);

      const resolvedMAC = router.resolveMAC('eth0', nextHopIP);

      expect(resolvedMAC?.equals(nextHopMAC)).toBe(true);
    });

    it('should return undefined when MAC not in cache', () => {
      const resolvedMAC = router.resolveMAC('eth0', new IPAddress('10.0.0.2'));

      expect(resolvedMAC).toBeUndefined();
    });
  });

  describe('frame reception', () => {
    beforeEach(() => {
      router.powerOn();
      router.setIPAddress('eth0', new IPAddress('10.0.0.1'), new SubnetMask('/24'));
      router.setIPAddress('eth1', new IPAddress('192.168.1.1'), new SubnetMask('/24'));
    });

    it('should extract and forward IP packet from frame', () => {
      let forwardedCount = 0;

      router.onPacketForward(() => {
        forwardedCount++;
      });

      const packet = new IPv4Packet({
        sourceIP: new IPAddress('10.0.0.10'),
        destinationIP: new IPAddress('192.168.1.10'),
        protocol: IPProtocol.TCP,
        ttl: 64,
        payload: Buffer.from([0x00, 0x01])
      });

      const packetBytes = packet.toBytes();
      const paddedPayload = Buffer.concat([packetBytes, Buffer.alloc(Math.max(0, 46 - packetBytes.length))]);

      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: router.getInterface('eth0')!.getMAC(),
        etherType: EtherType.IPv4,
        payload: paddedPayload
      });

      router.receiveFrame('eth0', frame);

      expect(forwardedCount).toBe(1);
    });

    it('should handle ARP frames', () => {
      const arpService = router.getARPService('eth0');

      const arpRequest = arpService.createRequest(
        new IPAddress('10.0.0.10'),
        new MACAddress('AA:BB:CC:DD:EE:FF'),
        new IPAddress('10.0.0.1')
      );

      const arpBytes = arpService.serializePacket(arpRequest);
      const paddedPayload = Buffer.concat([arpBytes, Buffer.alloc(Math.max(0, 46 - arpBytes.length))]);

      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: paddedPayload
      });

      let replySent = false;
      router.onFrameTransmit(() => {
        replySent = true;
      });

      router.receiveFrame('eth0', frame);

      expect(replySent).toBe(true);
    });
  });

  describe('statistics', () => {
    beforeEach(() => {
      router.powerOn();
      router.setIPAddress('eth0', new IPAddress('10.0.0.1'), new SubnetMask('/24'));
      router.setIPAddress('eth1', new IPAddress('192.168.1.1'), new SubnetMask('/24'));
    });

    it('should track forwarded packets', () => {
      const packet = new IPv4Packet({
        sourceIP: new IPAddress('10.0.0.10'),
        destinationIP: new IPAddress('192.168.1.10'),
        protocol: IPProtocol.TCP,
        ttl: 64,
        payload: Buffer.from([0x00, 0x01])
      });

      router.forwardPacket(packet, 'eth0');

      const stats = router.getStatistics();
      expect(stats.packetsForwarded).toBe(1);
    });

    it('should track dropped packets', () => {
      const packet = new IPv4Packet({
        sourceIP: new IPAddress('10.0.0.10'),
        destinationIP: new IPAddress('8.8.8.8'),
        protocol: IPProtocol.TCP,
        ttl: 64,
        payload: Buffer.from([0x00, 0x01])
      });

      router.forwardPacket(packet, 'eth0');

      const stats = router.getStatistics();
      expect(stats.packetsDropped).toBe(1);
    });
  });
});
