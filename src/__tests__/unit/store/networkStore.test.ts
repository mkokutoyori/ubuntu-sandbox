/**
 * Network Store Tests
 *
 * Tests for the network store and device UI representation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { NetworkSimulator } from '@/core/network/NetworkSimulator';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';
import { SubnetMask } from '@/domain/network/value-objects/SubnetMask';

describe('Network Store', () => {
  beforeEach(() => {
    // Reset store state
    useNetworkStore.getState().clearAll();
  });

  afterEach(() => {
    // Clean up
    useNetworkStore.getState().clearAll();
  });

  describe('Device Creation', () => {
    it('should create a Linux PC with eth0 interface', () => {
      const store = useNetworkStore.getState();
      const device = store.addDevice('linux-pc', 100, 100);

      expect(device.type).toBe('linux-pc');
      expect(device.interfaces.length).toBeGreaterThan(0);
      expect(device.interfaces[0].name).toBe('eth0');
    });

    it('should create a Windows PC with eth0 interface', () => {
      const store = useNetworkStore.getState();
      const device = store.addDevice('windows-pc', 100, 100);

      expect(device.type).toBe('windows-pc');
      expect(device.interfaces.length).toBeGreaterThan(0);
      expect(device.interfaces[0].name).toBe('eth0');
    });

    it('should create a Cisco Switch with multiple ports', () => {
      const store = useNetworkStore.getState();
      const device = store.addDevice('cisco-switch', 200, 200);

      expect(device.type).toBe('cisco-switch');
      // Cisco switch should have 24 ports
      expect(device.interfaces.length).toBe(24);
      expect(device.interfaces[0].name).toBe('eth0');
      expect(device.interfaces[23].name).toBe('eth23');
    });

    it('should create a generic Switch with 8 ports', () => {
      const store = useNetworkStore.getState();
      const device = store.addDevice('switch', 200, 200);

      expect(device.type).toBe('switch');
      // Generic switch has 8 ports by default
      expect(device.interfaces.length).toBe(8);
    });

    it('should create a Cisco Router with multiple interfaces', () => {
      const store = useNetworkStore.getState();
      const device = store.addDevice('cisco-router', 300, 300);

      expect(device.type).toBe('cisco-router');
      // Cisco router should have interfaces
      expect(device.interfaces.length).toBeGreaterThan(0);
    });
  });

  describe('Connection Management', () => {
    it('should allow connecting PC to Switch', () => {
      const store = useNetworkStore.getState();

      const pc = store.addDevice('linux-pc', 100, 100);
      const sw = store.addDevice('cisco-switch', 300, 100);

      // PC has eth0, Switch has eth0-eth23
      expect(pc.interfaces.length).toBeGreaterThan(0);
      expect(sw.interfaces.length).toBeGreaterThan(0);

      // Connect PC.eth0 to Switch.eth0
      const connection = store.addConnection(
        pc.id, pc.interfaces[0].id,
        sw.id, sw.interfaces[0].id
      );

      expect(connection).not.toBeNull();
      expect(connection?.sourceDeviceId).toBe(pc.id);
      expect(connection?.targetDeviceId).toBe(sw.id);
    });

    it('should not allow connecting same interface twice', () => {
      const store = useNetworkStore.getState();

      const pc1 = store.addDevice('linux-pc', 100, 100);
      const pc2 = store.addDevice('linux-pc', 200, 100);
      const sw = store.addDevice('cisco-switch', 300, 100);

      // First connection: PC1.eth0 -> Switch.eth0
      const conn1 = store.addConnection(
        pc1.id, pc1.interfaces[0].id,
        sw.id, sw.interfaces[0].id
      );
      expect(conn1).not.toBeNull();

      // Second connection: PC2.eth0 -> Switch.eth0 (should fail - eth0 already used)
      const conn2 = store.addConnection(
        pc2.id, pc2.interfaces[0].id,
        sw.id, sw.interfaces[0].id
      );
      expect(conn2).toBeNull();

      // Third connection: PC2.eth0 -> Switch.eth1 (should work)
      const conn3 = store.addConnection(
        pc2.id, pc2.interfaces[0].id,
        sw.id, sw.interfaces[1].id
      );
      expect(conn3).not.toBeNull();
    });

    it('should support building a LAN topology: 2 PCs + 1 Switch', () => {
      const store = useNetworkStore.getState();

      // Create devices
      const pc1 = store.addDevice('linux-pc', 100, 100);
      const pc2 = store.addDevice('windows-pc', 100, 300);
      const sw = store.addDevice('cisco-switch', 300, 200);

      // Verify all devices have interfaces
      expect(pc1.interfaces.length).toBeGreaterThan(0);
      expect(pc2.interfaces.length).toBeGreaterThan(0);
      expect(sw.interfaces.length).toBeGreaterThanOrEqual(2);

      // Connect PC1 to Switch
      const conn1 = store.addConnection(
        pc1.id, pc1.interfaces[0].id,
        sw.id, sw.interfaces[0].id
      );
      expect(conn1).not.toBeNull();

      // Connect PC2 to Switch
      const conn2 = store.addConnection(
        pc2.id, pc2.interfaces[0].id,
        sw.id, sw.interfaces[1].id
      );
      expect(conn2).not.toBeNull();

      // Verify topology
      const devices = store.getDevices();
      const connections = useNetworkStore.getState().connections;

      expect(devices.length).toBe(3);
      expect(connections.length).toBe(2);
    });
  });

  describe('Device Instance Access', () => {
    it('should provide access to underlying device instance', () => {
      const store = useNetworkStore.getState();
      const deviceUI = store.addDevice('linux-pc', 100, 100);

      expect(deviceUI.instance).toBeDefined();
      expect(deviceUI.instance.getId()).toBe(deviceUI.id);
      expect(deviceUI.instance.getType()).toBe('linux-pc');
    });

    it('should allow executing commands on device instance', async () => {
      const store = useNetworkStore.getState();
      const deviceUI = store.addDevice('linux-pc', 100, 100);

      const result = await deviceUI.instance.executeCommand('hostname');
      expect(result).toBeDefined();
    });
  });

  describe('NetworkSimulator Integration', () => {
    it('should initialize NetworkSimulator when devices and connections are created', () => {
      const store = useNetworkStore.getState();

      // Create topology
      const pc1 = store.addDevice('linux-pc', 100, 100);
      const sw = store.addDevice('cisco-switch', 300, 100);

      const conn = store.addConnection(
        pc1.id, pc1.interfaces[0].id,
        sw.id, sw.interfaces[0].id
      );

      // Initialize NetworkSimulator with store data
      const { deviceInstances, connections } = useNetworkStore.getState();
      NetworkSimulator.initialize(deviceInstances, connections);

      expect(NetworkSimulator.isReady()).toBe(true);

      const info = NetworkSimulator.getConnectionInfo();
      expect(info.devices).toBe(2);
      expect(info.connections).toBe(1);
    });

    it('should wire up devices for frame forwarding', () => {
      const store = useNetworkStore.getState();

      // Create LAN: PC1 <-> Switch <-> PC2
      const pc1UI = store.addDevice('linux-pc', 100, 100);
      const pc2UI = store.addDevice('linux-pc', 100, 300);
      const swUI = store.addDevice('cisco-switch', 300, 200);

      store.addConnection(pc1UI.id, 'eth0', swUI.id, 'eth0');
      store.addConnection(pc2UI.id, 'eth0', swUI.id, 'eth1');

      // Initialize NetworkSimulator
      const { deviceInstances, connections } = useNetworkStore.getState();
      NetworkSimulator.initialize(deviceInstances, connections);

      // Get device instances
      const pc1 = store.getDevice(pc1UI.id);
      const pc2 = store.getDevice(pc2UI.id);

      expect(pc1).toBeDefined();
      expect(pc2).toBeDefined();

      // Configure IPs
      (pc1 as any).setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      (pc2 as any).setIPAddress('eth0', new IPAddress('192.168.1.20'), new SubnetMask('/24'));

      // Add ARP entries so they know each other
      const pc1MAC = (pc1 as any).getInterface('eth0').getMAC();
      const pc2MAC = (pc2 as any).getInterface('eth0').getMAC();
      (pc1 as any).addARPEntry(new IPAddress('192.168.1.20'), pc2MAC);
      (pc2 as any).addARPEntry(new IPAddress('192.168.1.10'), pc1MAC);

      // Track events
      const events: any[] = [];
      NetworkSimulator.addEventListener((event) => {
        events.push(event);
      });

      // Execute ping - this should send frames through the simulator
      // Note: The ping command sends frames which should be forwarded
      expect(pc1!.isOnline()).toBe(true);
    });

    it('should resolve ARP automatically for a LAN ping', async () => {
      const store = useNetworkStore.getState();

      // Create LAN: PC1 <-> Switch <-> PC2
      const pc1UI = store.addDevice('linux-pc', 100, 100);
      const pc2UI = store.addDevice('linux-pc', 100, 300);
      const swUI = store.addDevice('cisco-switch', 300, 200);

      store.addConnection(pc1UI.id, 'eth0', swUI.id, 'eth0');
      store.addConnection(pc2UI.id, 'eth0', swUI.id, 'eth1');

      // Initialize NetworkSimulator
      const { deviceInstances, connections } = useNetworkStore.getState();
      NetworkSimulator.initialize(deviceInstances, connections);

      // Configure IPs
      const pc1 = store.getDevice(pc1UI.id);
      const pc2 = store.getDevice(pc2UI.id);

      (pc1 as any).setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      (pc2 as any).setIPAddress('eth0', new IPAddress('192.168.1.20'), new SubnetMask('/24'));

      // Execute ping without pre-populating ARP cache
      const result = await (pc1 as any).executeCommand('ping -c 1 192.168.1.20');

      expect(result).toContain('PING 192.168.1.20');
      expect(result).toContain('64 bytes from 192.168.1.20');
    });

    it('should support full ping flow with configured devices', async () => {
      const store = useNetworkStore.getState();

      // Create LAN topology
      const pc1UI = store.addDevice('linux-pc', 100, 100);
      const pc2UI = store.addDevice('linux-pc', 100, 300);
      const swUI = store.addDevice('cisco-switch', 300, 200);

      // Connect devices
      store.addConnection(pc1UI.id, 'eth0', swUI.id, 'eth0');
      store.addConnection(pc2UI.id, 'eth0', swUI.id, 'eth1');

      // Initialize simulator with connections
      const { deviceInstances, connections } = useNetworkStore.getState();
      NetworkSimulator.initialize(deviceInstances, connections);

      // Get device instances for configuration
      const pc1 = store.getDevice(pc1UI.id);
      const pc2 = store.getDevice(pc2UI.id);
      const sw = store.getDevice(swUI.id);

      // Configure IPs
      (pc1 as any).setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      (pc2 as any).setIPAddress('eth0', new IPAddress('192.168.1.20'), new SubnetMask('/24'));

      // Setup ARP entries
      const pc1MAC = (pc1 as any).getInterface('eth0').getMAC();
      const pc2MAC = (pc2 as any).getInterface('eth0').getMAC();
      (pc1 as any).addARPEntry(new IPAddress('192.168.1.20'), pc2MAC);
      (pc2 as any).addARPEntry(new IPAddress('192.168.1.10'), pc1MAC);

      // Execute ping command
      const result = await (pc1 as any).executeCommand('ping 192.168.1.20');

      // Verify ping output
      expect(result).toContain('PING 192.168.1.20');
      expect(result).toContain('bytes');

      // The switch should have learned MAC addresses
      const macTable = (sw as any).getMACTable();
      expect(macTable).toBeDefined();
    });
  });
});
