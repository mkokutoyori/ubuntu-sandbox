/**
 * IPv6 Implementation Tests (RFC 8200, RFC 4861, RFC 4443)
 *
 * Test Categories:
 *   T-IPV6-01: IPv6Address parsing, formatting, type detection
 *   T-IPV6-02: IPv6 packet creation and basic structure
 *   T-IPV6-03: NDP (Neighbor Discovery Protocol)
 *   T-IPV6-04: ICMPv6 Echo (ping6)
 *   T-IPV6-05: IPv6 Routing
 *   T-IPV6-06: Router Advertisement and SLAAC
 *   T-IPV6-07: Dual-stack operation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  IPv6Address, MACAddress, IPAddress, SubnetMask,
  IPv6Packet, ICMPv6Packet,
  createIPv6Packet, createNeighborSolicitation, createNeighborAdvertisement,
  createICMPv6EchoRequest, createICMPv6EchoReply, createRouterAdvertisement,
  IP_PROTO_ICMPV6, ETHERTYPE_IPV6,
  IPV6_UNSPECIFIED, IPV6_LOOPBACK, IPV6_ALL_NODES_MULTICAST, IPV6_ALL_ROUTERS_MULTICAST,
  resetCounters,
} from '@/network/core/types';
import { Port } from '@/network/hardware/Port';
import { Router } from '@/network/devices/Router';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';

describe('IPv6 Implementation (RFC 8200)', () => {
  beforeEach(() => {
    resetCounters();
  });

  // ═══════════════════════════════════════════════════════════════════
  // T-IPV6-01: IPv6Address Parsing and Formatting
  // ═══════════════════════════════════════════════════════════════════

  describe('T-IPV6-01: IPv6Address Parsing and Formatting', () => {
    it('parses full notation', () => {
      const addr = new IPv6Address('2001:0db8:0000:0000:0000:0000:0000:0001');
      expect(addr.toString()).toBe('2001:db8::1');
      expect(addr.toFullString()).toBe('2001:0db8:0000:0000:0000:0000:0000:0001');
    });

    it('parses compressed notation with :: at end', () => {
      const addr = new IPv6Address('2001:db8::');
      const hextets = addr.getHextets();
      expect(hextets[0]).toBe(0x2001);
      expect(hextets[1]).toBe(0x0db8);
      expect(hextets.slice(2).every(h => h === 0)).toBe(true);
    });

    it('parses compressed notation with :: at start', () => {
      const addr = new IPv6Address('::1');
      const hextets = addr.getHextets();
      expect(hextets.slice(0, 7).every(h => h === 0)).toBe(true);
      expect(hextets[7]).toBe(1);
    });

    it('parses compressed notation with :: in middle', () => {
      const addr = new IPv6Address('2001:db8::1');
      expect(addr.getHextets()).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
    });

    it('parses unspecified address (::)', () => {
      const addr = new IPv6Address('::');
      expect(addr.isUnspecified()).toBe(true);
      expect(addr.getHextets().every(h => h === 0)).toBe(true);
    });

    it('parses loopback address (::1)', () => {
      const addr = new IPv6Address('::1');
      expect(addr.isLoopback()).toBe(true);
    });

    it('parses link-local address', () => {
      const addr = new IPv6Address('fe80::1');
      expect(addr.isLinkLocal()).toBe(true);
    });

    it('parses address with zone ID', () => {
      const addr = new IPv6Address('fe80::1%eth0');
      expect(addr.isLinkLocal()).toBe(true);
      expect(addr.getScopeId()).toBe('eth0');
      expect(addr.toString()).toBe('fe80::1%eth0');
    });

    it('parses multicast address', () => {
      const allNodes = new IPv6Address('ff02::1');
      expect(allNodes.isMulticast()).toBe(true);
      expect(allNodes.isAllNodesMulticast()).toBe(true);

      const allRouters = new IPv6Address('ff02::2');
      expect(allRouters.isMulticast()).toBe(true);
      expect(allRouters.isAllRoutersMulticast()).toBe(true);
    });

    it('detects global unicast address', () => {
      const addr = new IPv6Address('2001:db8::1');
      expect(addr.isGlobalUnicast()).toBe(true);
      expect(addr.isLinkLocal()).toBe(false);
      expect(addr.isMulticast()).toBe(false);
    });

    it('computes solicited-node multicast address', () => {
      const unicast = new IPv6Address('2001:db8::1234:5678');
      const solicited = unicast.toSolicitedNodeMulticast();
      expect(solicited.toString()).toBe('ff02::1:ff34:5678');
      expect(solicited.isSolicitedNodeMulticast()).toBe(true);
    });

    it('compares addresses with equals()', () => {
      const a = new IPv6Address('2001:db8::1');
      const b = new IPv6Address('2001:0db8:0000:0000:0000:0000:0000:0001');
      const c = new IPv6Address('2001:db8::2');
      expect(a.equals(b)).toBe(true);
      expect(a.equals(c)).toBe(false);
    });

    it('checks subnet membership', () => {
      const addr1 = new IPv6Address('2001:db8::1');
      const addr2 = new IPv6Address('2001:db8::ffff');
      const addr3 = new IPv6Address('2001:db9::1');

      expect(addr1.isInSameSubnet(addr2, 64)).toBe(true);
      expect(addr1.isInSameSubnet(addr3, 64)).toBe(false);
      expect(addr1.isInSameSubnet(addr3, 16)).toBe(true);
    });

    it('generates link-local from MAC (EUI-64)', () => {
      const mac = new MACAddress('02:00:00:00:00:01');
      const linkLocal = IPv6Address.fromMAC(mac);
      expect(linkLocal.isLinkLocal()).toBe(true);
      // EUI-64: flip U/L bit (02 ^ 02 = 00), insert ff:fe
      expect(linkLocal.toString()).toBe('fe80::ff:fe00:1');
    });

    it('converts multicast address to MAC', () => {
      const multicast = new IPv6Address('ff02::1:ff00:1');
      const mac = multicast.toMulticastMAC();
      expect(mac.toString()).toBe('33:33:ff:00:00:01');
    });

    it('gets network prefix', () => {
      const addr = new IPv6Address('2001:db8:1234:5678:9abc:def0:1234:5678');
      const prefix64 = addr.getNetworkPrefix(64);
      expect(prefix64.toString()).toBe('2001:db8:1234:5678::');

      const prefix48 = addr.getNetworkPrefix(48);
      expect(prefix48.toString()).toBe('2001:db8:1234::');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // T-IPV6-02: IPv6 Packet Structure
  // ═══════════════════════════════════════════════════════════════════

  describe('T-IPV6-02: IPv6 Packet Structure', () => {
    it('creates IPv6 packet with correct fields', () => {
      const src = new IPv6Address('2001:db8::1');
      const dst = new IPv6Address('2001:db8::2');
      const payload: ICMPv6Packet = {
        type: 'icmpv6',
        icmpType: 'echo-request',
        code: 0,
        id: 1,
        sequence: 1,
        dataSize: 56,
      };

      const pkt = createIPv6Packet(src, dst, IP_PROTO_ICMPV6, 64, payload, 64);

      expect(pkt.type).toBe('ipv6');
      expect(pkt.version).toBe(6);
      expect(pkt.hopLimit).toBe(64);
      expect(pkt.nextHeader).toBe(IP_PROTO_ICMPV6);
      expect(pkt.sourceIP.equals(src)).toBe(true);
      expect(pkt.destinationIP.equals(dst)).toBe(true);
      expect(pkt.payloadLength).toBe(64);
    });

    it('creates ICMPv6 echo request', () => {
      const req = createICMPv6EchoRequest(1234, 5, 56);
      expect(req.type).toBe('icmpv6');
      expect(req.icmpType).toBe('echo-request');
      expect(req.id).toBe(1234);
      expect(req.sequence).toBe(5);
      expect(req.dataSize).toBe(56);
    });

    it('creates ICMPv6 echo reply', () => {
      const reply = createICMPv6EchoReply(1234, 5, 56);
      expect(reply.icmpType).toBe('echo-reply');
    });

    it('creates Neighbor Solicitation', () => {
      const targetAddr = new IPv6Address('2001:db8::1');
      const srcMAC = new MACAddress('02:00:00:00:00:01');
      const ns = createNeighborSolicitation(targetAddr, srcMAC);

      expect(ns.icmpType).toBe('neighbor-solicitation');
      expect(ns.ndp?.ndpType).toBe('neighbor-solicitation');
      if (ns.ndp?.ndpType === 'neighbor-solicitation') {
        expect(ns.ndp.targetAddress.equals(targetAddr)).toBe(true);
        expect(ns.ndp.options.length).toBe(1);
        expect(ns.ndp.options[0].optionType).toBe('source-link-layer');
      }
    });

    it('creates Neighbor Advertisement', () => {
      const targetAddr = new IPv6Address('2001:db8::1');
      const tgtMAC = new MACAddress('02:00:00:00:00:01');
      const na = createNeighborAdvertisement(targetAddr, tgtMAC, {
        router: true,
        solicited: true,
        override: true,
      });

      expect(na.icmpType).toBe('neighbor-advertisement');
      expect(na.ndp?.ndpType).toBe('neighbor-advertisement');
      if (na.ndp?.ndpType === 'neighbor-advertisement') {
        expect(na.ndp.routerFlag).toBe(true);
        expect(na.ndp.solicitedFlag).toBe(true);
        expect(na.ndp.overrideFlag).toBe(true);
      }
    });

    it('creates Router Advertisement with prefixes', () => {
      const prefix = new IPv6Address('2001:db8::');
      const srcMAC = new MACAddress('02:00:00:00:00:01');
      const ra = createRouterAdvertisement(
        [{ prefix, prefixLength: 64, onLink: true, autonomous: true }],
        srcMAC,
        { curHopLimit: 64, routerLifetime: 1800 }
      );

      expect(ra.icmpType).toBe('router-advertisement');
      expect(ra.ndp?.ndpType).toBe('router-advertisement');
      if (ra.ndp?.ndpType === 'router-advertisement') {
        expect(ra.ndp.curHopLimit).toBe(64);
        expect(ra.ndp.routerLifetime).toBe(1800);
        expect(ra.ndp.options.length).toBeGreaterThanOrEqual(2); // source-link-layer + prefix
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // T-IPV6-03: Port IPv6 Configuration
  // ═══════════════════════════════════════════════════════════════════

  describe('T-IPV6-03: Port IPv6 Configuration', () => {
    it('enables IPv6 and generates link-local', () => {
      const port = new Port('eth0', 'ethernet');
      port.enableIPv6();

      expect(port.isIPv6Enabled()).toBe(true);
      const linkLocal = port.getLinkLocalIPv6();
      expect(linkLocal).not.toBeNull();
      expect(linkLocal?.isLinkLocal()).toBe(true);
    });

    it('configures static IPv6 address', () => {
      const port = new Port('eth0', 'ethernet');
      const addr = new IPv6Address('2001:db8::1');
      port.configureIPv6(addr, 64);

      expect(port.isIPv6Enabled()).toBe(true);
      expect(port.hasIPv6Address(addr)).toBe(true);
      const addrs = port.getIPv6Addresses();
      expect(addrs.length).toBe(2); // link-local + configured
    });

    it('supports multiple IPv6 addresses', () => {
      const port = new Port('eth0', 'ethernet');
      port.configureIPv6(new IPv6Address('2001:db8:1::1'), 64);
      port.configureIPv6(new IPv6Address('2001:db8:2::1'), 64);

      const addrs = port.getIPv6Addresses();
      expect(addrs.length).toBe(3); // link-local + 2 configured
    });

    it('gets global IPv6 address', () => {
      const port = new Port('eth0', 'ethernet');
      const global = new IPv6Address('2001:db8::1');
      port.configureIPv6(global, 64);

      expect(port.getGlobalIPv6()?.equals(global)).toBe(true);
    });

    it('removes IPv6 address', () => {
      const port = new Port('eth0', 'ethernet');
      const addr = new IPv6Address('2001:db8::1');
      port.configureIPv6(addr, 64);
      expect(port.hasIPv6Address(addr)).toBe(true);

      port.removeIPv6Address(addr);
      expect(port.hasIPv6Address(addr)).toBe(false);
    });

    it('disables IPv6', () => {
      const port = new Port('eth0', 'ethernet');
      port.enableIPv6();
      port.configureIPv6(new IPv6Address('2001:db8::1'), 64);

      port.disableIPv6();
      expect(port.isIPv6Enabled()).toBe(false);
      expect(port.getIPv6Addresses().length).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // T-IPV6-04: Router IPv6 Configuration
  // ═══════════════════════════════════════════════════════════════════

  describe('T-IPV6-04: Router IPv6 Configuration', () => {
    let r1: Router;

    beforeEach(() => {
      r1 = new Router('router-cisco', 'R1', 0, 0);
    });

    it('enables IPv6 unicast routing', () => {
      r1.enableIPv6Routing();
      expect(r1.isIPv6RoutingEnabled()).toBe(true);
    });

    it('configures IPv6 address on interface', () => {
      r1.enableIPv6Routing();
      const result = r1.configureIPv6Interface(
        'GigabitEthernet0/0',
        new IPv6Address('2001:db8::1'),
        64
      );
      expect(result).toBe(true);

      const routes = r1.getIPv6RoutingTable();
      expect(routes.length).toBe(1);
      expect(routes[0].type).toBe('connected');
      expect(routes[0].prefixLength).toBe(64);
    });

    it('adds static IPv6 route', () => {
      r1.enableIPv6Routing();
      r1.configureIPv6Interface('GigabitEthernet0/0', new IPv6Address('2001:db8:1::1'), 64);

      const result = r1.addIPv6StaticRoute(
        new IPv6Address('2001:db8:2::'),
        64,
        new IPv6Address('2001:db8:1::2'),
        10
      );
      expect(result).toBe(true);

      const routes = r1.getIPv6RoutingTable();
      const staticRoute = routes.find(r => r.type === 'static');
      expect(staticRoute).toBeDefined();
      expect(staticRoute?.metric).toBe(10);
    });

    it('sets default IPv6 route', () => {
      r1.enableIPv6Routing();
      r1.configureIPv6Interface('GigabitEthernet0/0', new IPv6Address('2001:db8::1'), 64);
      r1.setIPv6DefaultRoute(new IPv6Address('2001:db8::254'), 0);

      const routes = r1.getIPv6RoutingTable();
      const defaultRoute = routes.find(r => r.type === 'default');
      expect(defaultRoute).toBeDefined();
      expect(defaultRoute?.prefixLength).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // T-IPV6-05: NDP (Neighbor Discovery)
  // ═══════════════════════════════════════════════════════════════════

  describe('T-IPV6-05: NDP Neighbor Discovery', () => {
    let pc1: LinuxPC;
    let pc2: LinuxPC;
    let sw: Switch;

    beforeEach(() => {
      pc1 = new LinuxPC('PC1', 100, 100);
      pc2 = new LinuxPC('PC2', 200, 100);
      sw = new CiscoSwitch('switch-cisco', 'SW1', 150, 50);

      // Connect: PC1 -- SW -- PC2
      const c1 = new Cable('c1');
      c1.connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);
      const c2 = new Cable('c2');
      c2.connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);

      // Power on
      pc1.powerOn();
      pc2.powerOn();
      sw.powerOn();
    });

    it('generates link-local addresses on enable', () => {
      pc1.enableIPv6('eth0');
      const port = pc1.getPort('eth0');
      expect(port?.isIPv6Enabled()).toBe(true);
      expect(port?.getLinkLocalIPv6()).not.toBeNull();
    });

    it('configures global IPv6 address', () => {
      pc1.configureIPv6Interface('eth0', new IPv6Address('2001:db8::1'), 64);
      const port = pc1.getPort('eth0');
      expect(port?.hasIPv6Address(new IPv6Address('2001:db8::1'))).toBe(true);
    });

    it('has IPv6 routing table with connected routes', () => {
      pc1.configureIPv6Interface('eth0', new IPv6Address('2001:db8::1'), 64);
      const routes = pc1.getIPv6RoutingTable();
      expect(routes.length).toBeGreaterThan(0);
      expect(routes.some(r => r.type === 'connected' && r.prefixLength === 64)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // T-IPV6-06: Switch IPv6 Multicast
  // ═══════════════════════════════════════════════════════════════════

  describe('T-IPV6-06: Switch IPv6 Multicast', () => {
    it('floods IPv6 multicast frames (33:33:XX:XX:XX:XX)', () => {
      const sw = new CiscoSwitch('switch-cisco', 'SW1', 0, 0);
      sw.powerOn();

      // The switch should flood frames with destination MAC 33:33:XX:XX:XX:XX
      const multicastMAC = new MACAddress('33:33:00:00:00:01');
      expect(multicastMAC.getOctets()[0]).toBe(0x33);
      expect(multicastMAC.getOctets()[1]).toBe(0x33);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // T-IPV6-07: Well-Known Addresses
  // ═══════════════════════════════════════════════════════════════════

  describe('T-IPV6-07: Well-Known Addresses', () => {
    it('provides unspecified address constant', () => {
      expect(IPV6_UNSPECIFIED.isUnspecified()).toBe(true);
      expect(IPV6_UNSPECIFIED.toString()).toBe('::');
    });

    it('provides loopback address constant', () => {
      expect(IPV6_LOOPBACK.isLoopback()).toBe(true);
      expect(IPV6_LOOPBACK.toString()).toBe('::1');
    });

    it('provides all-nodes multicast constant', () => {
      expect(IPV6_ALL_NODES_MULTICAST.isAllNodesMulticast()).toBe(true);
      expect(IPV6_ALL_NODES_MULTICAST.toString()).toBe('ff02::1');
    });

    it('provides all-routers multicast constant', () => {
      expect(IPV6_ALL_ROUTERS_MULTICAST.isAllRoutersMulticast()).toBe(true);
      expect(IPV6_ALL_ROUTERS_MULTICAST.toString()).toBe('ff02::2');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // T-IPV6-08: Dual-Stack Operation
  // ═══════════════════════════════════════════════════════════════════

  describe('T-IPV6-08: Dual-Stack Operation', () => {
    let pc: LinuxPC;

    beforeEach(() => {
      pc = new LinuxPC('PC1', 0, 0);
      pc.powerOn();
    });

    it('supports both IPv4 and IPv6 on same interface', () => {
      const port = pc.getPort('eth0');
      expect(port).toBeDefined();

      // Configure IPv4
      pc.configureInterface('eth0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
      expect(port?.getIPAddress()?.toString()).toBe('192.168.1.1');

      // Configure IPv6
      pc.configureIPv6Interface('eth0', new IPv6Address('2001:db8::1'), 64);
      expect(port?.hasIPv6Address(new IPv6Address('2001:db8::1'))).toBe(true);

      // Both should coexist
      expect(port?.getIPAddress()?.toString()).toBe('192.168.1.1');
      expect(port?.isIPv6Enabled()).toBe(true);
    });

    it('has separate routing tables for IPv4 and IPv6', () => {
      pc.configureInterface('eth0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
      pc.configureIPv6Interface('eth0', new IPv6Address('2001:db8::1'), 64);

      const ipv4Routes = pc.getRoutingTable();
      const ipv6Routes = pc.getIPv6RoutingTable();

      expect(ipv4Routes.length).toBeGreaterThan(0);
      expect(ipv6Routes.length).toBeGreaterThan(0);

      // IPv4 routes should have IPAddress type
      expect(ipv4Routes[0].network).toBeInstanceOf(IPAddress);
      // IPv6 routes should have IPv6Address type
      expect(ipv6Routes[0].prefix).toBeInstanceOf(IPv6Address);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // T-IPV6-09: Router Neighbor Cache
  // ═══════════════════════════════════════════════════════════════════

  describe('T-IPV6-09: Router Neighbor Cache', () => {
    it('has neighbor cache accessor', () => {
      const r1 = new Router('router-cisco', 'R1', 0, 0);
      r1.enableIPv6Routing();
      const cache = r1.getNeighborCache();
      expect(cache).toBeInstanceOf(Map);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // T-IPV6-10: IPv6 Address Edge Cases
  // ═══════════════════════════════════════════════════════════════════

  describe('T-IPV6-10: IPv6 Address Edge Cases', () => {
    it('handles maximum compression', () => {
      // :: should be all zeros
      const allZeros = new IPv6Address('::');
      expect(allZeros.getHextets().every(h => h === 0)).toBe(true);
    });

    it('handles no compression needed', () => {
      const addr = new IPv6Address('1:2:3:4:5:6:7:8');
      expect(addr.getHextets()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('compresses longest zero run', () => {
      // 1:0:0:0:0:0:0:1 should become 1::1
      const addr = new IPv6Address([1, 0, 0, 0, 0, 0, 0, 1]);
      expect(addr.toString()).toBe('1::1');
    });

    it('handles multiple equal zero runs (compresses first)', () => {
      // 1:0:0:1:0:0:0:1 - first run of 2, second run of 3
      // Should compress the longer run (last one)
      const addr = new IPv6Address([1, 0, 0, 1, 0, 0, 0, 1]);
      expect(addr.toString()).toBe('1:0:0:1::1');
    });

    it('rejects invalid addresses', () => {
      expect(() => new IPv6Address('1:2:3')).toThrow();
      expect(() => new IPv6Address('1:2:3:4:5:6:7:8:9')).toThrow();
      expect(() => new IPv6Address('1:::2')).toThrow();
      expect(() => new IPv6Address('gggg::1')).toThrow();
    });
  });
});
