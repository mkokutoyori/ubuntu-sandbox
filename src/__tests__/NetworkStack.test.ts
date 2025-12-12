/**
 * NetworkStack Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { NetworkStack } from '../devices/common/NetworkStack';
import { NetworkInterfaceConfig } from '../devices/common/types';

describe('NetworkStack', () => {
  let networkStack: NetworkStack;
  let testInterface: NetworkInterfaceConfig;

  beforeEach(() => {
    testInterface = {
      id: 'eth0-id',
      name: 'eth0',
      type: 'ethernet',
      macAddress: '00:11:22:33:44:55',
      isUp: true,
      speed: '1Gbps',
      duplex: 'auto'
    };

    networkStack = new NetworkStack({
      interfaces: [testInterface],
      hostname: 'test-host',
      arpTimeout: 300,
      defaultTTL: 64
    });
  });

  describe('Interface Management', () => {
    it('should return all interfaces', () => {
      const interfaces = networkStack.getInterfaces();
      expect(interfaces).toHaveLength(1);
      expect(interfaces[0].name).toBe('eth0');
    });

    it('should get interface by ID', () => {
      const iface = networkStack.getInterface('eth0-id');
      expect(iface).toBeDefined();
      expect(iface?.name).toBe('eth0');
    });

    it('should get interface by name', () => {
      const iface = networkStack.getInterfaceByName('eth0');
      expect(iface).toBeDefined();
      expect(iface?.id).toBe('eth0-id');
    });

    it('should return undefined for non-existent interface', () => {
      const iface = networkStack.getInterface('nonexistent');
      expect(iface).toBeUndefined();
    });

    it('should configure interface with IP address', () => {
      const success = networkStack.configureInterface('eth0-id', {
        ipAddress: '192.168.1.100',
        subnetMask: '255.255.255.0'
      });
      expect(success).toBe(true);

      const iface = networkStack.getInterface('eth0-id');
      expect(iface?.ipAddress).toBe('192.168.1.100');
      expect(iface?.subnetMask).toBe('255.255.255.0');
    });

    it('should return false when configuring non-existent interface', () => {
      const success = networkStack.configureInterface('nonexistent', {
        ipAddress: '192.168.1.100'
      });
      expect(success).toBe(false);
    });
  });

  describe('IP Address Utilities', () => {
    it('should validate correct IP addresses', () => {
      expect(networkStack.isValidIP('192.168.1.1')).toBe(true);
      expect(networkStack.isValidIP('0.0.0.0')).toBe(true);
      expect(networkStack.isValidIP('255.255.255.255')).toBe(true);
      expect(networkStack.isValidIP('10.0.0.1')).toBe(true);
    });

    it('should reject invalid IP addresses', () => {
      expect(networkStack.isValidIP('256.1.1.1')).toBe(false);
      expect(networkStack.isValidIP('192.168.1')).toBe(false);
      expect(networkStack.isValidIP('abc.def.ghi.jkl')).toBe(false);
      expect(networkStack.isValidIP('')).toBe(false);
    });

    it('should validate correct netmasks', () => {
      expect(networkStack.isValidNetmask('255.255.255.0')).toBe(true);
      expect(networkStack.isValidNetmask('255.255.0.0')).toBe(true);
      expect(networkStack.isValidNetmask('255.0.0.0')).toBe(true);
      expect(networkStack.isValidNetmask('255.255.255.128')).toBe(true);
    });

    it('should reject invalid netmasks', () => {
      expect(networkStack.isValidNetmask('255.255.255.1')).toBe(false);
      expect(networkStack.isValidNetmask('255.0.255.0')).toBe(false);
    });

    it('should convert IP to number and back', () => {
      const ip = '192.168.1.100';
      const num = networkStack.ipToNumber(ip);
      expect(networkStack.numberToIP(num)).toBe(ip);
    });

    it('should calculate network address', () => {
      const network = networkStack.getNetworkAddress('192.168.1.100', '255.255.255.0');
      expect(network).toBe('192.168.1.0');
    });

    it('should calculate broadcast address', () => {
      const broadcast = networkStack.getBroadcastAddress('192.168.1.100', '255.255.255.0');
      expect(broadcast).toBe('192.168.1.255');
    });

    it('should convert netmask to prefix', () => {
      expect(networkStack.netmaskToPrefix('255.255.255.0')).toBe(24);
      expect(networkStack.netmaskToPrefix('255.255.0.0')).toBe(16);
      expect(networkStack.netmaskToPrefix('255.0.0.0')).toBe(8);
      expect(networkStack.netmaskToPrefix('255.255.255.128')).toBe(25);
    });

    it('should convert prefix to netmask', () => {
      expect(networkStack.prefixToNetmask(24)).toBe('255.255.255.0');
      expect(networkStack.prefixToNetmask(16)).toBe('255.255.0.0');
      expect(networkStack.prefixToNetmask(8)).toBe('255.0.0.0');
    });

    it('should check if IP is in network', () => {
      expect(networkStack.isIPInNetwork('192.168.1.100', '192.168.1.0', '255.255.255.0')).toBe(true);
      expect(networkStack.isIPInNetwork('192.168.1.100', '192.168.2.0', '255.255.255.0')).toBe(false);
      expect(networkStack.isIPInNetwork('10.0.0.5', '10.0.0.0', '255.255.255.0')).toBe(true);
    });
  });

  describe('ARP Table Management', () => {
    it('should start with empty ARP table', () => {
      const arpTable = networkStack.getARPTable();
      expect(arpTable).toHaveLength(0);
    });

    it('should add ARP entry', () => {
      networkStack.addARPEntry('192.168.1.1', '00:AA:BB:CC:DD:EE', 'eth0');
      const arpTable = networkStack.getARPTable();
      expect(arpTable).toHaveLength(1);
      expect(arpTable[0].ipAddress).toBe('192.168.1.1');
      expect(arpTable[0].macAddress).toBe('00:AA:BB:CC:DD:EE');
    });

    it('should add static ARP entry', () => {
      networkStack.addARPEntry('192.168.1.1', '00:AA:BB:CC:DD:EE', 'eth0', true);
      const arpTable = networkStack.getARPTable();
      expect(arpTable[0].type).toBe('static');
    });

    it('should lookup ARP entry', () => {
      networkStack.addARPEntry('192.168.1.1', '00:AA:BB:CC:DD:EE', 'eth0');
      const mac = networkStack.lookupARP('192.168.1.1');
      expect(mac).toBe('00:AA:BB:CC:DD:EE');
    });

    it('should return undefined for unknown IP', () => {
      const mac = networkStack.lookupARP('192.168.1.1');
      expect(mac).toBeUndefined();
    });

    it('should remove ARP entry', () => {
      networkStack.addARPEntry('192.168.1.1', '00:AA:BB:CC:DD:EE', 'eth0');
      const removed = networkStack.removeARPEntry('192.168.1.1');
      expect(removed).toBe(true);
      expect(networkStack.getARPTable()).toHaveLength(0);
    });

    it('should clear dynamic ARP entries', () => {
      networkStack.addARPEntry('192.168.1.1', '00:AA:BB:CC:DD:EE', 'eth0', false);
      networkStack.addARPEntry('192.168.1.2', '00:AA:BB:CC:DD:FF', 'eth0', true);
      networkStack.clearDynamicARPEntries();

      const arpTable = networkStack.getARPTable();
      expect(arpTable).toHaveLength(1);
      expect(arpTable[0].type).toBe('static');
    });
  });

  describe('Routing Table Management', () => {
    beforeEach(() => {
      networkStack.configureInterface('eth0-id', {
        ipAddress: '192.168.1.100',
        subnetMask: '255.255.255.0'
      });
    });

    it('should have connected route after interface configuration', () => {
      const routes = networkStack.getRoutingTable();
      expect(routes.length).toBeGreaterThan(0);
      expect(routes[0].destination).toBe('192.168.1.0');
      expect(routes[0].protocol).toBe('connected');
    });

    it('should add static route', () => {
      const success = networkStack.addStaticRoute('10.0.0.0', '255.255.255.0', '192.168.1.1', 'eth0');
      expect(success).toBe(true);

      const routes = networkStack.getRoutingTable();
      const staticRoute = routes.find(r => r.destination === '10.0.0.0');
      expect(staticRoute).toBeDefined();
      expect(staticRoute?.gateway).toBe('192.168.1.1');
      expect(staticRoute?.protocol).toBe('static');
    });

    it('should not add duplicate route', () => {
      networkStack.addStaticRoute('10.0.0.0', '255.255.255.0', '192.168.1.1', 'eth0');
      const success = networkStack.addStaticRoute('10.0.0.0', '255.255.255.0', '192.168.1.2', 'eth0');
      expect(success).toBe(false);
    });

    it('should remove route', () => {
      networkStack.addStaticRoute('10.0.0.0', '255.255.255.0', '192.168.1.1', 'eth0');
      const removed = networkStack.removeRoute('10.0.0.0', '255.255.255.0');
      expect(removed).toBe(true);
    });

    it('should lookup route for destination', () => {
      networkStack.addStaticRoute('10.0.0.0', '255.255.255.0', '192.168.1.1', 'eth0');
      const route = networkStack.lookupRoute('10.0.0.50');
      expect(route).toBeDefined();
      expect(route?.destination).toBe('10.0.0.0');
    });

    it('should use longest prefix match', () => {
      networkStack.addStaticRoute('10.0.0.0', '255.0.0.0', '192.168.1.1', 'eth0');
      networkStack.addStaticRoute('10.0.0.0', '255.255.0.0', '192.168.1.2', 'eth0');

      const route = networkStack.lookupRoute('10.0.1.50');
      expect(route?.gateway).toBe('192.168.1.2'); // More specific route
    });
  });
});
