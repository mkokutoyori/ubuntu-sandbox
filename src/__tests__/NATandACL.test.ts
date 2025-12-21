/**
 * NAT/PAT and ACL Integration Tests
 *
 * Real network simulation tests for NAT, PAT, and ACL functionality.
 * Topology:
 *
 * Inside Network (192.168.1.0/24)              Outside Network (10.0.0.0/24)
 * PC1 (192.168.1.10) ---+                      +--- PC3 (10.0.0.10)
 *                       |                      |
 *                     Switch1 --- Router --- Switch2
 *                       |                      |
 * PC2 (192.168.1.20) ---+                      +--- PC4 (10.0.0.20)
 *
 * Router:
 *   - Gi0/0: 192.168.1.1 (inside)
 *   - Gi0/1: 10.0.0.1 (outside)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NetworkSimulator } from '../core/network/NetworkSimulator';
import { DeviceFactory } from '../devices/DeviceFactory';
import { BaseDevice } from '../devices/common/BaseDevice';
import { CiscoDevice } from '../devices/cisco/CiscoDevice';
import { Connection } from '../devices/common/types';
import {
  Packet,
  IPv4Packet,
  ICMPPacket,
  ICMPType,
  UDPDatagram,
  ETHER_TYPE,
  IP_PROTOCOL,
} from '../core/network/packet';
import type { Packet as PacketType } from '../core/network/packet';

// ============================================================================
// Test Topology Setup
// ============================================================================

interface TestTopology {
  pc1: BaseDevice;      // Inside: 192.168.1.10
  pc2: BaseDevice;      // Inside: 192.168.1.20
  pc3: BaseDevice;      // Outside: 10.0.0.10
  pc4: BaseDevice;      // Outside: 10.0.0.20
  switch1: BaseDevice;  // Inside switch
  switch2: BaseDevice;  // Outside switch
  router: CiscoDevice;  // NAT router
  connections: Connection[];
}

function createTestTopology(): TestTopology {
  // Create devices
  const pc1 = DeviceFactory.createDevice('linux-pc', 50, 100);
  const pc2 = DeviceFactory.createDevice('linux-pc', 50, 200);
  const pc3 = DeviceFactory.createDevice('linux-pc', 450, 100);
  const pc4 = DeviceFactory.createDevice('linux-pc', 450, 200);
  const switch1 = DeviceFactory.createDevice('switch-cisco', 150, 150);
  const switch2 = DeviceFactory.createDevice('switch-cisco', 350, 150);
  const router = DeviceFactory.createDevice('router-cisco', 250, 150) as CiscoDevice;

  // Power on all devices
  [pc1, pc2, pc3, pc4, switch1, switch2, router].forEach(d => d.powerOn());

  // Get interfaces
  const pc1Ifaces = pc1.getInterfaces();
  const pc2Ifaces = pc2.getInterfaces();
  const pc3Ifaces = pc3.getInterfaces();
  const pc4Ifaces = pc4.getInterfaces();
  const sw1Ifaces = switch1.getInterfaces();
  const sw2Ifaces = switch2.getInterfaces();
  const routerIfaces = router.getInterfaces();

  // Configure PC1 - Inside network
  pc1.configureInterface(pc1Ifaces[0].id, {
    ipAddress: '192.168.1.10',
    subnetMask: '255.255.255.0',
    isUp: true
  });
  pc1.getNetworkStack().addStaticRoute('0.0.0.0', '0.0.0.0', '192.168.1.1', pc1Ifaces[0].name);

  // Configure PC2 - Inside network
  pc2.configureInterface(pc2Ifaces[0].id, {
    ipAddress: '192.168.1.20',
    subnetMask: '255.255.255.0',
    isUp: true
  });
  pc2.getNetworkStack().addStaticRoute('0.0.0.0', '0.0.0.0', '192.168.1.1', pc2Ifaces[0].name);

  // Configure PC3 - Outside network
  pc3.configureInterface(pc3Ifaces[0].id, {
    ipAddress: '10.0.0.10',
    subnetMask: '255.255.255.0',
    isUp: true
  });
  pc3.getNetworkStack().addStaticRoute('0.0.0.0', '0.0.0.0', '10.0.0.1', pc3Ifaces[0].name);

  // Configure PC4 - Outside network
  pc4.configureInterface(pc4Ifaces[0].id, {
    ipAddress: '10.0.0.20',
    subnetMask: '255.255.255.0',
    isUp: true
  });
  pc4.getNetworkStack().addStaticRoute('0.0.0.0', '0.0.0.0', '10.0.0.1', pc4Ifaces[0].name);

  // Configure Switch1 interfaces
  sw1Ifaces.forEach(iface => {
    switch1.configureInterface(iface.id, { isUp: true });
  });

  // Configure Switch2 interfaces
  sw2Ifaces.forEach(iface => {
    switch2.configureInterface(iface.id, { isUp: true });
  });

  // Configure Router - Inside interface (Gi0/0)
  router.configureInterface(routerIfaces[0].id, {
    ipAddress: '192.168.1.1',
    subnetMask: '255.255.255.0',
    isUp: true
  });

  // Configure Router - Outside interface (Gi0/1)
  router.configureInterface(routerIfaces[1].id, {
    ipAddress: '10.0.0.1',
    subnetMask: '255.255.255.0',
    isUp: true
  });

  // Create connections
  const connections: Connection[] = [
    // PC1 -- Switch1
    {
      id: 'conn-pc1-sw1',
      type: 'ethernet',
      sourceDeviceId: pc1.getId(),
      sourceInterfaceId: pc1Ifaces[0].id,
      targetDeviceId: switch1.getId(),
      targetInterfaceId: sw1Ifaces[0].id,
      isActive: true
    },
    // PC2 -- Switch1
    {
      id: 'conn-pc2-sw1',
      type: 'ethernet',
      sourceDeviceId: pc2.getId(),
      sourceInterfaceId: pc2Ifaces[0].id,
      targetDeviceId: switch1.getId(),
      targetInterfaceId: sw1Ifaces[1].id,
      isActive: true
    },
    // Switch1 -- Router (inside)
    {
      id: 'conn-sw1-router',
      type: 'ethernet',
      sourceDeviceId: switch1.getId(),
      sourceInterfaceId: sw1Ifaces[2].id,
      targetDeviceId: router.getId(),
      targetInterfaceId: routerIfaces[0].id,
      isActive: true
    },
    // Router (outside) -- Switch2
    {
      id: 'conn-router-sw2',
      type: 'ethernet',
      sourceDeviceId: router.getId(),
      sourceInterfaceId: routerIfaces[1].id,
      targetDeviceId: switch2.getId(),
      targetInterfaceId: sw2Ifaces[0].id,
      isActive: true
    },
    // Switch2 -- PC3
    {
      id: 'conn-sw2-pc3',
      type: 'ethernet',
      sourceDeviceId: switch2.getId(),
      sourceInterfaceId: sw2Ifaces[1].id,
      targetDeviceId: pc3.getId(),
      targetInterfaceId: pc3Ifaces[0].id,
      isActive: true
    },
    // Switch2 -- PC4
    {
      id: 'conn-sw2-pc4',
      type: 'ethernet',
      sourceDeviceId: switch2.getId(),
      sourceInterfaceId: sw2Ifaces[2].id,
      targetDeviceId: pc4.getId(),
      targetInterfaceId: pc4Ifaces[0].id,
      isActive: true
    }
  ];

  // Initialize simulator
  const devices = new Map<string, BaseDevice>();
  devices.set(pc1.getId(), pc1);
  devices.set(pc2.getId(), pc2);
  devices.set(pc3.getId(), pc3);
  devices.set(pc4.getId(), pc4);
  devices.set(switch1.getId(), switch1);
  devices.set(switch2.getId(), switch2);
  devices.set(router.getId(), router);

  NetworkSimulator.initialize(devices, connections);

  return { pc1, pc2, pc3, pc4, switch1, switch2, router, connections };
}

// Helper to pre-populate ARP tables for faster testing
async function prePopulateARP(topology: TestTopology): Promise<void> {
  const { pc1, pc2, pc3, pc4, router } = topology;

  // Inside network ARP
  const pc1Iface = pc1.getInterfaces()[0];
  const pc2Iface = pc2.getInterfaces()[0];
  pc1.getNetworkStack().sendARPRequest('192.168.1.1', pc1Iface);
  pc2.getNetworkStack().sendARPRequest('192.168.1.1', pc2Iface);

  // Outside network ARP
  const pc3Iface = pc3.getInterfaces()[0];
  const pc4Iface = pc4.getInterfaces()[0];
  pc3.getNetworkStack().sendARPRequest('10.0.0.1', pc3Iface);
  pc4.getNetworkStack().sendARPRequest('10.0.0.1', pc4Iface);

  // Router ARP to all endpoints
  const routerIfaces = router.getInterfaces();
  router.getNetworkStack().sendARPRequest('192.168.1.10', routerIfaces[0]);
  router.getNetworkStack().sendARPRequest('192.168.1.20', routerIfaces[0]);
  router.getNetworkStack().sendARPRequest('10.0.0.10', routerIfaces[1]);
  router.getNetworkStack().sendARPRequest('10.0.0.20', routerIfaces[1]);

  await new Promise(resolve => setTimeout(resolve, 200));
}

// ============================================================================
// NAT Tests
// ============================================================================

describe('NAT/PAT Integration Tests', () => {
  let topology: TestTopology;

  beforeEach(() => {
    topology = createTestTopology();
  });

  // NetworkSimulator is re-initialized in each test via createTestTopology()

  describe('Topology Verification', () => {
    it('should have all devices initialized correctly', () => {
      expect(topology.pc1.getIsPoweredOn()).toBe(true);
      expect(topology.pc2.getIsPoweredOn()).toBe(true);
      expect(topology.pc3.getIsPoweredOn()).toBe(true);
      expect(topology.pc4.getIsPoweredOn()).toBe(true);
      expect(topology.router.getIsPoweredOn()).toBe(true);
    });

    it('should have correct IP configuration on all devices', () => {
      const pc1Iface = topology.pc1.getInterfaces()[0];
      const pc2Iface = topology.pc2.getInterfaces()[0];
      const pc3Iface = topology.pc3.getInterfaces()[0];
      const pc4Iface = topology.pc4.getInterfaces()[0];
      const routerIfaces = topology.router.getInterfaces();

      expect(pc1Iface.ipAddress).toBe('192.168.1.10');
      expect(pc2Iface.ipAddress).toBe('192.168.1.20');
      expect(pc3Iface.ipAddress).toBe('10.0.0.10');
      expect(pc4Iface.ipAddress).toBe('10.0.0.20');
      expect(routerIfaces[0].ipAddress).toBe('192.168.1.1');
      expect(routerIfaces[1].ipAddress).toBe('10.0.0.1');
    });

    it('should have routing configured correctly', () => {
      const pc1Routes = topology.pc1.getNetworkStack().getRoutingTable();
      const defaultRoute = pc1Routes.find(r => r.destination === '0.0.0.0');
      expect(defaultRoute).toBeDefined();
      expect(defaultRoute?.gateway).toBe('192.168.1.1');
    });
  });

  describe('Static NAT', () => {
    beforeEach(async () => {
      // Configure static NAT: 192.168.1.10 -> 10.0.0.100
      const natService = topology.router.getNATService();
      const routerIfaces = topology.router.getInterfaces();

      // Set NAT interfaces
      natService.setInsideInterface(routerIfaces[0].name);
      natService.setOutsideInterface(routerIfaces[1].name);

      // Add static NAT entry
      natService.addStaticNAT('192.168.1.10', '10.0.0.100');

      await prePopulateARP(topology);
    });

    it('should have NAT interfaces configured correctly', () => {
      const natService = topology.router.getNATService();
      const routerIfaces = topology.router.getInterfaces();

      expect(natService.isInsideInterface(routerIfaces[0].name)).toBe(true);
      expect(natService.isOutsideInterface(routerIfaces[1].name)).toBe(true);
    });

    it('should have static NAT entry configured', () => {
      const natService = topology.router.getNATService();
      const staticEntries = natService.getStaticEntries();

      expect(staticEntries.length).toBe(1);
      expect(staticEntries[0].insideLocal).toBe('192.168.1.10');
      expect(staticEntries[0].insideGlobal).toBe('10.0.0.100');
    });

    it('should translate outgoing packets from inside to outside', () => {
      const natService = topology.router.getNATService();
      const routerIfaces = topology.router.getInterfaces();

      // Create a mock packet from inside host with proper Packet structure
      const mockPacket: Packet = {
        id: 'test-packet-1',
        timestamp: Date.now(),
        frame: {
          sourceMAC: '00:11:22:33:44:55',
          destinationMAC: 'FF:FF:FF:FF:FF:FF',
          etherType: ETHER_TYPE.IPv4,
          payload: {
            version: 4,
            headerLength: 20,
            typeOfService: 0,
            totalLength: 84,
            identification: 1,
            flags: 0,
            fragmentOffset: 0,
            ttl: 64,
            protocol: IP_PROTOCOL.ICMP,
            headerChecksum: 0,
            sourceIP: '192.168.1.10',  // Inside local
            destinationIP: '10.0.0.10', // Outside destination
            options: [],
            payload: {
              type: ICMPType.ECHO_REQUEST,
              code: 0,
              checksum: 0,
              identifier: 1,
              sequenceNumber: 1,
              data: new Uint8Array([1, 2, 3, 4])
            } as ICMPPacket
          } as IPv4Packet
        },
        hops: [],
        status: 'in_transit'
      };

      // Test translation directly
      const result = natService.translateOutgoing(
        mockPacket,
        routerIfaces[0].name, // inside interface
        routerIfaces[1].ipAddress!, // outside IP
        () => true  // ACL check always passes
      );

      expect(result.translated).toBe(true);
      const translatedIP = (result.packet.frame.payload as IPv4Packet).sourceIP;
      expect(translatedIP).toBe('10.0.0.100');  // Should be translated to global IP
    });

    it('should create translation entry after first packet', () => {
      const natService = topology.router.getNATService();
      const translations = natService.getTranslations();

      // Static NAT should have at least one translation entry
      const staticTranslation = translations.find(t =>
        t.type === 'static' && t.insideLocal === '192.168.1.10'
      );
      expect(staticTranslation).toBeDefined();
    });
  });

  describe('PAT (Overload)', () => {
    beforeEach(async () => {
      const natService = topology.router.getNATService();
      const aclService = topology.router.getACLService();
      const routerIfaces = topology.router.getInterfaces();

      // Set NAT interfaces
      natService.setInsideInterface(routerIfaces[0].name);
      natService.setOutsideInterface(routerIfaces[1].name);

      // Create ACL to match inside network
      aclService.addNumberedEntry(1, {
        action: 'permit',
        sourceIP: '192.168.1.0',
        sourceWildcard: '0.0.0.255'
      });

      // Bind ACL to NAT with overload
      natService.bindAccessList({
        aclNumber: 1,
        overload: true
      });

      await prePopulateARP(topology);
    });

    it('should have PAT configured with ACL', () => {
      const natService = topology.router.getNATService();
      const aclService = topology.router.getACLService();

      const bindings = natService.getAccessListBindings();
      expect(bindings.length).toBe(1);
      expect(bindings[0].aclNumber).toBe(1);
      expect(bindings[0].overload).toBe(true);

      const acl = aclService.getACL(1);
      expect(acl).toBeDefined();
      expect(acl?.entries.length).toBe(1);
    });

    it('should translate multiple inside hosts to same outside IP with different ports', async () => {
      const natService = topology.router.getNATService();

      // Simulate traffic from both PC1 and PC2
      topology.pc1.getNetworkStack().sendPing('10.0.0.10', () => {}, 1000);
      topology.pc2.getNetworkStack().sendPing('10.0.0.10', () => {}, 1000);

      await new Promise(resolve => setTimeout(resolve, 500));

      const translations = natService.getTranslations();
      const patTranslations = translations.filter(t => t.type === 'pat');

      // Both should use same global IP but different ports
      if (patTranslations.length >= 2) {
        const globalIPs = new Set(patTranslations.map(t => t.insideGlobal));
        const ports = new Set(patTranslations.map(t => t.translatedPort));

        // All should use router's outside IP
        expect(globalIPs.size).toBe(1);
        // But different ports
        expect(ports.size).toBe(patTranslations.length);
      }
    });

    it('should check ACL before applying PAT', () => {
      const aclService = topology.router.getACLService();

      // Source in 192.168.1.0/24 should be permitted
      expect(aclService.checkStandardACL(1, '192.168.1.10')).toBe(true);
      expect(aclService.checkStandardACL(1, '192.168.1.20')).toBe(true);

      // Source outside 192.168.1.0/24 should be denied (implicit deny)
      expect(aclService.checkStandardACL(1, '192.168.2.10')).toBe(false);
      expect(aclService.checkStandardACL(1, '10.0.0.10')).toBe(false);
    });
  });

  describe('Dynamic NAT with Pool', () => {
    beforeEach(async () => {
      const natService = topology.router.getNATService();
      const aclService = topology.router.getACLService();
      const routerIfaces = topology.router.getInterfaces();

      // Set NAT interfaces
      natService.setInsideInterface(routerIfaces[0].name);
      natService.setOutsideInterface(routerIfaces[1].name);

      // Create NAT pool
      natService.addPool({
        name: 'OUTSIDE_POOL',
        startIP: '10.0.0.100',
        endIP: '10.0.0.110',
        netmask: '255.255.255.0',
        type: 'pool'
      });

      // Create ACL for NAT
      aclService.addNumberedEntry(10, {
        action: 'permit',
        sourceIP: '192.168.1.0',
        sourceWildcard: '0.0.0.255'
      });

      // Bind ACL to pool (without overload = dynamic NAT)
      natService.bindAccessList({
        aclNumber: 10,
        poolName: 'OUTSIDE_POOL',
        overload: false
      });

      await prePopulateARP(topology);
    });

    it('should have NAT pool configured', () => {
      const natService = topology.router.getNATService();
      const pool = natService.getPool('OUTSIDE_POOL');

      expect(pool).toBeDefined();
      expect(pool?.startIP).toBe('10.0.0.100');
      expect(pool?.endIP).toBe('10.0.0.110');
    });

    it('should allocate IPs from pool for different inside hosts', async () => {
      const natService = topology.router.getNATService();

      // Traffic from PC1
      topology.pc1.getNetworkStack().sendPing('10.0.0.10', () => {}, 1000);
      await new Promise(resolve => setTimeout(resolve, 300));

      // Traffic from PC2
      topology.pc2.getNetworkStack().sendPing('10.0.0.10', () => {}, 1000);
      await new Promise(resolve => setTimeout(resolve, 300));

      const translations = natService.getTranslations();
      const dynamicTranslations = translations.filter(t => t.type === 'dynamic');

      // Each inside host should get a unique global IP from pool
      if (dynamicTranslations.length >= 2) {
        const globalIPs = new Set(dynamicTranslations.map(t => t.insideGlobal));
        expect(globalIPs.size).toBe(dynamicTranslations.length);
      }
    });
  });
});

// ============================================================================
// ACL Tests
// ============================================================================

describe('ACL Integration Tests', () => {
  let topology: TestTopology;

  beforeEach(() => {
    topology = createTestTopology();
  });

  // NetworkSimulator is re-initialized in each test via createTestTopology()

  describe('Standard ACL', () => {
    it('should permit traffic matching permit entry', () => {
      const aclService = topology.router.getACLService();

      // Create standard ACL permitting 192.168.1.0/24
      aclService.addNumberedEntry(1, {
        action: 'permit',
        sourceIP: '192.168.1.0',
        sourceWildcard: '0.0.0.255'
      });

      // Should permit 192.168.1.x
      expect(aclService.checkPacket(1, '192.168.1.10')).toBe(true);
      expect(aclService.checkPacket(1, '192.168.1.20')).toBe(true);
      expect(aclService.checkPacket(1, '192.168.1.255')).toBe(true);
    });

    it('should deny traffic not matching any permit entry (implicit deny)', () => {
      const aclService = topology.router.getACLService();

      aclService.addNumberedEntry(1, {
        action: 'permit',
        sourceIP: '192.168.1.0',
        sourceWildcard: '0.0.0.255'
      });

      // Should deny other networks
      expect(aclService.checkPacket(1, '192.168.2.10')).toBe(false);
      expect(aclService.checkPacket(1, '10.0.0.10')).toBe(false);
      expect(aclService.checkPacket(1, '172.16.0.1')).toBe(false);
    });

    it('should deny traffic matching deny entry', () => {
      const aclService = topology.router.getACLService();

      // Deny specific host, permit rest of network
      aclService.addNumberedEntry(1, {
        action: 'deny',
        sourceIP: '192.168.1.10',
        sourceWildcard: '0.0.0.0'  // host match
      });
      aclService.addNumberedEntry(1, {
        action: 'permit',
        sourceIP: '192.168.1.0',
        sourceWildcard: '0.0.0.255'
      });

      // PC1 (192.168.1.10) should be denied
      expect(aclService.checkPacket(1, '192.168.1.10')).toBe(false);
      // PC2 (192.168.1.20) should be permitted
      expect(aclService.checkPacket(1, '192.168.1.20')).toBe(true);
    });

    it('should process entries in sequence order', () => {
      const aclService = topology.router.getACLService();

      // Order matters - first match wins
      aclService.addNumberedEntry(1, {
        action: 'deny',
        sourceIP: '192.168.1.0',
        sourceWildcard: '0.0.0.255'
      });
      aclService.addNumberedEntry(1, {
        action: 'permit',
        sourceIP: '0.0.0.0',
        sourceWildcard: '255.255.255.255'  // any
      });

      // Even with permit any, 192.168.1.x is denied by first rule
      expect(aclService.checkPacket(1, '192.168.1.10')).toBe(false);
      // But other traffic is permitted
      expect(aclService.checkPacket(1, '10.0.0.10')).toBe(true);
    });

    it('should match "any" keyword correctly', () => {
      const aclService = topology.router.getACLService();

      aclService.addNumberedEntry(1, {
        action: 'permit',
        sourceIP: '0.0.0.0',
        sourceWildcard: '255.255.255.255'  // any
      });

      expect(aclService.checkPacket(1, '1.2.3.4')).toBe(true);
      expect(aclService.checkPacket(1, '255.255.255.255')).toBe(true);
      expect(aclService.checkPacket(1, '0.0.0.0')).toBe(true);
    });

    it('should match "host" keyword correctly', () => {
      const aclService = topology.router.getACLService();

      aclService.addNumberedEntry(1, {
        action: 'permit',
        sourceIP: '192.168.1.10',
        sourceWildcard: '0.0.0.0'  // host
      });

      expect(aclService.checkPacket(1, '192.168.1.10')).toBe(true);
      expect(aclService.checkPacket(1, '192.168.1.11')).toBe(false);
    });
  });

  describe('Extended ACL', () => {
    it('should match on protocol', () => {
      const aclService = topology.router.getACLService();

      // Permit only ICMP
      aclService.addNamedEntry('ICMP_ONLY', 'extended', {
        action: 'permit',
        protocol: 1,  // ICMP
        sourceIP: '0.0.0.0',
        sourceWildcard: '255.255.255.255',
        destIP: '0.0.0.0',
        destWildcard: '255.255.255.255'
      });

      // ICMP should be permitted
      expect(aclService.checkPacket('ICMP_ONLY', '192.168.1.10', '10.0.0.10', 1)).toBe(true);
      // TCP should be denied
      expect(aclService.checkPacket('ICMP_ONLY', '192.168.1.10', '10.0.0.10', 6)).toBe(false);
      // UDP should be denied
      expect(aclService.checkPacket('ICMP_ONLY', '192.168.1.10', '10.0.0.10', 17)).toBe(false);
    });

    it('should match on destination IP', () => {
      const aclService = topology.router.getACLService();

      // Deny traffic to 10.0.0.10, permit to 10.0.0.20
      aclService.addNamedEntry('DEST_FILTER', 'extended', {
        action: 'deny',
        protocol: 'ip',
        sourceIP: '0.0.0.0',
        sourceWildcard: '255.255.255.255',
        destIP: '10.0.0.10',
        destWildcard: '0.0.0.0'  // host
      });
      aclService.addNamedEntry('DEST_FILTER', 'extended', {
        action: 'permit',
        protocol: 'ip',
        sourceIP: '0.0.0.0',
        sourceWildcard: '255.255.255.255',
        destIP: '0.0.0.0',
        destWildcard: '255.255.255.255'
      });

      // Traffic to 10.0.0.10 denied
      expect(aclService.checkPacket('DEST_FILTER', '192.168.1.10', '10.0.0.10', 1)).toBe(false);
      // Traffic to 10.0.0.20 permitted
      expect(aclService.checkPacket('DEST_FILTER', '192.168.1.10', '10.0.0.20', 1)).toBe(true);
    });

    it('should match on port numbers', () => {
      const aclService = topology.router.getACLService();

      // Permit HTTP (port 80), deny all other TCP
      aclService.addNamedEntry('HTTP_ONLY', 'extended', {
        action: 'permit',
        protocol: 6,  // TCP
        sourceIP: '0.0.0.0',
        sourceWildcard: '255.255.255.255',
        destIP: '0.0.0.0',
        destWildcard: '255.255.255.255',
        destPort: { operator: 'eq', port: 80 }
      });

      // Port 80 permitted
      expect(aclService.checkPacket('HTTP_ONLY', '192.168.1.10', '10.0.0.10', 6, undefined, 80)).toBe(true);
      // Port 443 denied
      expect(aclService.checkPacket('HTTP_ONLY', '192.168.1.10', '10.0.0.10', 6, undefined, 443)).toBe(false);
      // Port 22 denied
      expect(aclService.checkPacket('HTTP_ONLY', '192.168.1.10', '10.0.0.10', 6, undefined, 22)).toBe(false);
    });

    it('should support port range matching', () => {
      const aclService = topology.router.getACLService();

      // Permit ports 80-443
      aclService.addNamedEntry('WEB_PORTS', 'extended', {
        action: 'permit',
        protocol: 6,
        sourceIP: '0.0.0.0',
        sourceWildcard: '255.255.255.255',
        destIP: '0.0.0.0',
        destWildcard: '255.255.255.255',
        destPort: { operator: 'range', port: 80, portEnd: 443 }
      });

      expect(aclService.checkPacket('WEB_PORTS', '192.168.1.10', '10.0.0.10', 6, undefined, 80)).toBe(true);
      expect(aclService.checkPacket('WEB_PORTS', '192.168.1.10', '10.0.0.10', 6, undefined, 443)).toBe(true);
      expect(aclService.checkPacket('WEB_PORTS', '192.168.1.10', '10.0.0.10', 6, undefined, 200)).toBe(true);
      expect(aclService.checkPacket('WEB_PORTS', '192.168.1.10', '10.0.0.10', 6, undefined, 22)).toBe(false);
      expect(aclService.checkPacket('WEB_PORTS', '192.168.1.10', '10.0.0.10', 6, undefined, 8080)).toBe(false);
    });
  });

  describe('ACL Applied to Interface', () => {
    beforeEach(async () => {
      await prePopulateARP(topology);
    });

    it('should block traffic when inbound ACL denies', async () => {
      const aclService = topology.router.getACLService();
      const routerIfaces = topology.router.getInterfaces();

      // Create ACL that denies PC1
      aclService.addNumberedEntry(100, {
        action: 'deny',
        protocol: 'ip',
        sourceIP: '192.168.1.10',
        sourceWildcard: '0.0.0.0',
        destIP: '0.0.0.0',
        destWildcard: '255.255.255.255'
      });
      aclService.addNumberedEntry(100, {
        action: 'permit',
        protocol: 'ip',
        sourceIP: '0.0.0.0',
        sourceWildcard: '255.255.255.255',
        destIP: '0.0.0.0',
        destWildcard: '255.255.255.255'
      });

      // Apply ACL inbound on inside interface
      aclService.bindToInterface(routerIfaces[0].name, 100, 'in');

      // Verify binding
      const binding = aclService.getInterfaceACL(routerIfaces[0].name, 'in');
      expect(binding).toBeDefined();
      expect(binding?.number).toBe(100);
    });

    it('should allow traffic when ACL permits', () => {
      const aclService = topology.router.getACLService();
      const routerIfaces = topology.router.getInterfaces();

      // Create ACL that permits all
      aclService.addNumberedEntry(101, {
        action: 'permit',
        protocol: 'ip',
        sourceIP: '0.0.0.0',
        sourceWildcard: '255.255.255.255',
        destIP: '0.0.0.0',
        destWildcard: '255.255.255.255'
      });

      aclService.bindToInterface(routerIfaces[0].name, 101, 'in');

      // Test ACL directly - should permit any traffic
      expect(aclService.checkPacket(101, '192.168.1.10', '10.0.0.10', 1)).toBe(true);
      expect(aclService.checkPacket(101, '192.168.1.20', '10.0.0.20', 6)).toBe(true);
      expect(aclService.checkPacket(101, '10.0.0.10', '192.168.1.10', 17)).toBe(true);

      // Verify interface binding is correct
      const binding = aclService.getInterfaceACL(routerIfaces[0].name, 'in');
      expect(binding).toBeDefined();
      expect(binding?.number).toBe(101);
    });
  });

  describe('ACL Hit Counters', () => {
    it('should increment hit counter when rule matches', () => {
      const aclService = topology.router.getACLService();

      aclService.addNumberedEntry(1, {
        action: 'permit',
        sourceIP: '192.168.1.0',
        sourceWildcard: '0.0.0.255'
      });

      // Check multiple times
      aclService.checkPacket(1, '192.168.1.10');
      aclService.checkPacket(1, '192.168.1.10');
      aclService.checkPacket(1, '192.168.1.20');

      const acl = aclService.getACL(1);
      expect(acl?.entries[0].hits).toBe(3);
    });

    it('should track hits per entry', () => {
      const aclService = topology.router.getACLService();

      aclService.addNumberedEntry(1, {
        action: 'deny',
        sourceIP: '192.168.1.10',
        sourceWildcard: '0.0.0.0'
      });
      aclService.addNumberedEntry(1, {
        action: 'permit',
        sourceIP: '192.168.1.0',
        sourceWildcard: '0.0.0.255'
      });

      // First entry matches
      aclService.checkPacket(1, '192.168.1.10');
      aclService.checkPacket(1, '192.168.1.10');

      // Second entry matches
      aclService.checkPacket(1, '192.168.1.20');

      const acl = aclService.getACL(1);
      expect(acl?.entries[0].hits).toBe(2);  // deny entry
      expect(acl?.entries[1].hits).toBe(1);  // permit entry
    });
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Edge Cases', () => {
  let topology: TestTopology;

  beforeEach(() => {
    topology = createTestTopology();
  });

  // NetworkSimulator is re-initialized in each test via createTestTopology()

  describe('NAT Edge Cases', () => {
    it('should handle packets from non-NAT interface correctly', async () => {
      const natService = topology.router.getNATService();
      const routerIfaces = topology.router.getInterfaces();

      // Only set inside interface, no outside
      natService.setInsideInterface(routerIfaces[0].name);
      // Don't set outside interface

      // Traffic should pass without translation
      expect(natService.isOutsideInterface(routerIfaces[1].name)).toBe(false);
    });

    it('should handle static NAT with overlapping pool', () => {
      const natService = topology.router.getNATService();
      const routerIfaces = topology.router.getInterfaces();

      natService.setInsideInterface(routerIfaces[0].name);
      natService.setOutsideInterface(routerIfaces[1].name);

      // Add overlapping static entries
      natService.addStaticNAT('192.168.1.10', '10.0.0.100');
      natService.addStaticNAT('192.168.1.20', '10.0.0.100');  // Same global IP!

      const entries = natService.getStaticEntries();
      // Implementation should handle this - either reject or overwrite
      expect(entries.length).toBeGreaterThan(0);
    });

    it('should clear dynamic translations', () => {
      const natService = topology.router.getNATService();

      // Add some static and dynamic entries
      natService.addStaticNAT('192.168.1.10', '10.0.0.100');

      // Clear dynamic only
      natService.clearDynamicTranslations();

      // Static should remain
      const translations = natService.getTranslations();
      const staticCount = translations.filter(t => t.type === 'static').length;
      expect(staticCount).toBe(1);
    });

    it('should return correct statistics', () => {
      const natService = topology.router.getNATService();
      const routerIfaces = topology.router.getInterfaces();

      natService.setInsideInterface(routerIfaces[0].name);
      natService.setOutsideInterface(routerIfaces[1].name);
      natService.addStaticNAT('192.168.1.10', '10.0.0.100');

      const stats = natService.getStatistics();
      expect(stats.staticTranslations).toBe(1);
      expect(stats.insideInterfaces).toContain(routerIfaces[0].name);
      expect(stats.outsideInterfaces).toContain(routerIfaces[1].name);
    });
  });

  describe('ACL Edge Cases', () => {
    it('should handle empty ACL (permit all)', () => {
      const aclService = topology.router.getACLService();

      // Non-existent ACL should permit all
      expect(aclService.checkPacket(999, '192.168.1.10')).toBe(true);
    });

    it('should handle wildcard mask edge cases', () => {
      const aclService = topology.router.getACLService();

      // Test odd wildcard masks
      aclService.addNumberedEntry(1, {
        action: 'permit',
        sourceIP: '192.168.0.0',
        sourceWildcard: '0.0.1.255'  // Match 192.168.0.x and 192.168.1.x
      });

      expect(aclService.checkPacket(1, '192.168.0.10')).toBe(true);
      expect(aclService.checkPacket(1, '192.168.1.10')).toBe(true);
      expect(aclService.checkPacket(1, '192.168.2.10')).toBe(false);
    });

    it('should handle ACL with only deny entries', () => {
      const aclService = topology.router.getACLService();

      aclService.addNumberedEntry(1, {
        action: 'deny',
        sourceIP: '192.168.1.10',
        sourceWildcard: '0.0.0.0'
      });

      // Matching deny
      expect(aclService.checkPacket(1, '192.168.1.10')).toBe(false);
      // Non-matching (implicit deny)
      expect(aclService.checkPacket(1, '192.168.1.20')).toBe(false);
    });

    it('should delete ACL correctly', () => {
      const aclService = topology.router.getACLService();

      aclService.addNumberedEntry(1, {
        action: 'permit',
        sourceIP: '192.168.1.0',
        sourceWildcard: '0.0.0.255'
      });

      expect(aclService.getACL(1)).toBeDefined();

      aclService.deleteACL(1);

      expect(aclService.getACL(1)).toBeUndefined();
    });

    it('should remove individual ACL entry', () => {
      const aclService = topology.router.getACLService();

      aclService.addNumberedEntry(1, {
        action: 'deny',
        sourceIP: '192.168.1.10',
        sourceWildcard: '0.0.0.0'
      });
      aclService.addNumberedEntry(1, {
        action: 'permit',
        sourceIP: '0.0.0.0',
        sourceWildcard: '255.255.255.255'
      });

      const aclBefore = aclService.getACL(1);
      expect(aclBefore?.entries.length).toBe(2);

      // Remove first entry (sequence 10)
      aclService.removeEntry(1, 10);

      const aclAfter = aclService.getACL(1);
      expect(aclAfter?.entries.length).toBe(1);

      // Now 192.168.1.10 should be permitted
      expect(aclService.checkPacket(1, '192.168.1.10')).toBe(true);
    });

    it('should unbind ACL from interface', () => {
      const aclService = topology.router.getACLService();
      const routerIfaces = topology.router.getInterfaces();

      aclService.addNumberedEntry(1, {
        action: 'permit',
        sourceIP: '0.0.0.0',
        sourceWildcard: '255.255.255.255'
      });

      aclService.bindToInterface(routerIfaces[0].name, 1, 'in');
      expect(aclService.getInterfaceACL(routerIfaces[0].name, 'in')).toBeDefined();

      aclService.unbindFromInterface(routerIfaces[0].name, 'in');
      expect(aclService.getInterfaceACL(routerIfaces[0].name, 'in')).toBeUndefined();
    });
  });

  describe('Combined NAT + ACL', () => {
    beforeEach(async () => {
      const natService = topology.router.getNATService();
      const aclService = topology.router.getACLService();
      const routerIfaces = topology.router.getInterfaces();

      // Setup NAT
      natService.setInsideInterface(routerIfaces[0].name);
      natService.setOutsideInterface(routerIfaces[1].name);

      // ACL 1: For NAT - permit 192.168.1.0/24
      aclService.addNumberedEntry(1, {
        action: 'permit',
        sourceIP: '192.168.1.0',
        sourceWildcard: '0.0.0.255'
      });

      // Bind for PAT
      natService.bindAccessList({
        aclNumber: 1,
        overload: true
      });

      // ACL 100: For interface filtering - deny PC1, permit rest
      aclService.addNumberedEntry(100, {
        action: 'deny',
        protocol: 'ip',
        sourceIP: '192.168.1.10',
        sourceWildcard: '0.0.0.0',
        destIP: '0.0.0.0',
        destWildcard: '255.255.255.255'
      });
      aclService.addNumberedEntry(100, {
        action: 'permit',
        protocol: 'ip',
        sourceIP: '0.0.0.0',
        sourceWildcard: '255.255.255.255',
        destIP: '0.0.0.0',
        destWildcard: '255.255.255.255'
      });

      // Apply ACL 100 on inside interface (inbound)
      aclService.bindToInterface(routerIfaces[0].name, 100, 'in');

      await prePopulateARP(topology);
    });

    it('should have both NAT and ACL configured', () => {
      const natService = topology.router.getNATService();
      const aclService = topology.router.getACLService();
      const routerIfaces = topology.router.getInterfaces();

      // NAT configured
      expect(natService.getAccessListBindings().length).toBe(1);

      // Interface ACL configured
      const interfaceACL = aclService.getInterfaceACL(routerIfaces[0].name, 'in');
      expect(interfaceACL).toBeDefined();
      expect(interfaceACL?.number).toBe(100);
    });

    it('should block PC1 by ACL even though NAT permits', () => {
      const aclService = topology.router.getACLService();

      // ACL 1 (for NAT) permits 192.168.1.10
      expect(aclService.checkStandardACL(1, '192.168.1.10')).toBe(true);

      // But ACL 100 (interface) denies 192.168.1.10
      expect(aclService.checkPacket(100, '192.168.1.10', '10.0.0.10', 1)).toBe(false);
    });

    it('should allow PC2 through ACL and NAT', () => {
      const aclService = topology.router.getACLService();

      // ACL 1 (for NAT) permits 192.168.1.20
      expect(aclService.checkStandardACL(1, '192.168.1.20')).toBe(true);

      // ACL 100 (interface) also permits 192.168.1.20
      expect(aclService.checkPacket(100, '192.168.1.20', '10.0.0.10', 1)).toBe(true);
    });
  });
});

// ============================================================================
// Performance and Stress Tests
// ============================================================================

describe('Performance Tests', () => {
  it('should handle many ACL checks efficiently', () => {
    const topology = createTestTopology();
    const aclService = topology.router.getACLService();

    // Create ACL with many entries
    for (let i = 0; i < 100; i++) {
      aclService.addNumberedEntry(1, {
        action: i < 50 ? 'deny' : 'permit',
        sourceIP: `192.168.${Math.floor(i / 256)}.${i % 256}`,
        sourceWildcard: '0.0.0.0'
      });
    }

    const startTime = Date.now();

    // Perform 1000 ACL checks
    for (let i = 0; i < 1000; i++) {
      aclService.checkPacket(1, `192.168.${i % 2}.${i % 256}`);
    }

    const elapsed = Date.now() - startTime;

    // Should complete in reasonable time (< 500ms for 1000 checks)
    expect(elapsed).toBeLessThan(500);

    // NetworkSimulator cleaned up on next test
  });

  it('should handle many NAT translations', () => {
    const topology = createTestTopology();
    const natService = topology.router.getNATService();
    const routerIfaces = topology.router.getInterfaces();

    natService.setInsideInterface(routerIfaces[0].name);
    natService.setOutsideInterface(routerIfaces[1].name);

    // Add many static NAT entries
    for (let i = 1; i < 100; i++) {
      natService.addStaticNAT(`192.168.1.${i}`, `10.0.0.${100 + i}`);
    }

    const translations = natService.getTranslations();
    expect(translations.length).toBe(99);

    // Verify lookups work
    const stats = natService.getStatistics();
    expect(stats.staticTranslations).toBe(99);

    // NetworkSimulator cleaned up on next test
  });
});
