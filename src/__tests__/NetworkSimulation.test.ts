/**
 * Network Simulation Tests
 *
 * Tests the complete network simulation including:
 * - Frame transmission between devices
 * - Switch MAC learning and forwarding
 * - ARP resolution
 * - ICMP ping end-to-end
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { NetworkSimulator } from '../core/network/NetworkSimulator';
import { DeviceFactory } from '../devices/DeviceFactory';
import { BaseDevice } from '../devices/common/BaseDevice';
import { Connection } from '../devices/common/types';
import {
  EthernetFrame,
  Packet,
  ARPPacket,
  ARPOpcode,
  IPv4Packet,
  ICMPPacket,
  ICMPType,
  ETHER_TYPE,
  IP_PROTOCOL,
  BROADCAST_MAC,
  generatePacketId,
  createARPRequest
} from '../core/network/packet';

describe('Network Simulation', () => {
  let pc1: BaseDevice;
  let pc2: BaseDevice;
  let switch1: BaseDevice;
  let connections: Connection[];

  beforeEach(() => {
    // Create devices
    pc1 = DeviceFactory.createDevice('linux-pc', 100, 100);
    pc2 = DeviceFactory.createDevice('linux-pc', 300, 100);
    switch1 = DeviceFactory.createDevice('switch-cisco', 200, 200);

    // Power on all devices
    pc1.powerOn();
    pc2.powerOn();
    switch1.powerOn();

    // Get interface IDs
    const pc1Interfaces = pc1.getInterfaces();
    const pc2Interfaces = pc2.getInterfaces();
    const switch1Interfaces = switch1.getInterfaces();

    // Configure IP addresses on PCs
    pc1.configureInterface(pc1Interfaces[0].id, {
      ipAddress: '192.168.1.10',
      subnetMask: '255.255.255.0',
      isUp: true
    });

    pc2.configureInterface(pc2Interfaces[0].id, {
      ipAddress: '192.168.1.20',
      subnetMask: '255.255.255.0',
      isUp: true
    });

    // Bring up switch interfaces
    switch1.configureInterface(switch1Interfaces[0].id, { isUp: true });
    switch1.configureInterface(switch1Interfaces[1].id, { isUp: true });

    // Create connections: PC1 -- Switch -- PC2
    connections = [
      {
        id: 'conn-1',
        type: 'ethernet',
        sourceDeviceId: pc1.getId(),
        sourceInterfaceId: pc1Interfaces[0].id,
        targetDeviceId: switch1.getId(),
        targetInterfaceId: switch1Interfaces[0].id,
        isActive: true
      },
      {
        id: 'conn-2',
        type: 'ethernet',
        sourceDeviceId: pc2.getId(),
        sourceInterfaceId: pc2Interfaces[0].id,
        targetDeviceId: switch1.getId(),
        targetInterfaceId: switch1Interfaces[1].id,
        isActive: true
      }
    ];

    // Initialize simulator
    const devices = new Map<string, BaseDevice>();
    devices.set(pc1.getId(), pc1);
    devices.set(pc2.getId(), pc2);
    devices.set(switch1.getId(), switch1);

    NetworkSimulator.initialize(devices, connections);
  });

  describe('Basic Connectivity', () => {
    it('should have simulator initialized with correct device count', () => {
      expect(NetworkSimulator.isReady()).toBe(true);
      expect(NetworkSimulator.getDevices().size).toBe(3);
    });

    it('should have correct connections', () => {
      const connInfo = NetworkSimulator.getConnectionInfo();
      expect(connInfo).toHaveLength(2);
    });
  });

  describe('ARP Resolution', () => {
    it('should send ARP request for unknown MAC', () => {
      return new Promise<void>((resolve) => {
        const pc1Iface = pc1.getInterfaces()[0];
        const events: any[] = [];

        const unsubscribe = () => {
          NetworkSimulator.removeEventListener(listener);
        };

        const listener = (event: any) => {
          events.push(event);

          // Check for ARP request
          if (event.type === 'frame_sent' && event.frame?.etherType === ETHER_TYPE.ARP) {
            const arpPacket = event.frame.payload as ARPPacket;
            expect(arpPacket.opcode).toBe(ARPOpcode.REQUEST);
            expect(arpPacket.targetIP).toBe('192.168.1.20');
            unsubscribe();
            resolve();
          }
        };

        NetworkSimulator.addEventListener(listener);

        // Trigger ARP by trying to send to unknown IP
        pc1.getNetworkStack().sendARPRequest('192.168.1.20', pc1Iface);
      });
    });

    it('should learn MAC address from ARP request', async () => {
      const pc1Iface = pc1.getInterfaces()[0];

      // Send ARP from PC1
      pc1.getNetworkStack().sendARPRequest('192.168.1.20', pc1Iface);

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 100));

      // PC2 should have learned PC1's MAC
      const pc2Arp = pc2.getNetworkStack().getARPTable();
      const pc1Entry = pc2Arp.find(e => e.ipAddress === '192.168.1.10');
      expect(pc1Entry).toBeDefined();
      expect(pc1Entry?.macAddress.toUpperCase()).toBe(pc1Iface.macAddress.toUpperCase());
    });

    it('should receive ARP reply and learn MAC', async () => {
      const pc1Iface = pc1.getInterfaces()[0];

      // Send ARP from PC1
      pc1.getNetworkStack().sendARPRequest('192.168.1.20', pc1Iface);

      // Wait for ARP reply
      await new Promise(resolve => setTimeout(resolve, 150));

      // PC1 should now have PC2's MAC in its ARP table
      const pc1Arp = pc1.getNetworkStack().getARPTable();
      const pc2Entry = pc1Arp.find(e => e.ipAddress === '192.168.1.20');
      expect(pc2Entry).toBeDefined();
    });
  });

  describe('Switch MAC Learning', () => {
    it('should learn source MAC on ingress port', async () => {
      const pc1Iface = pc1.getInterfaces()[0];

      // Send a frame from PC1
      pc1.getNetworkStack().sendARPRequest('192.168.1.20', pc1Iface);

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 100));

      // Check switch MAC table
      const macTable = NetworkSimulator.getMACTable(switch1.getId());
      expect(macTable).not.toBeNull();
      expect(macTable!.length).toBeGreaterThan(0);

      // Should have PC1's MAC
      const pc1Entry = macTable!.find(e =>
        e.macAddress.toUpperCase() === pc1Iface.macAddress.toUpperCase()
      );
      expect(pc1Entry).toBeDefined();
    });

    it('should flood broadcast frames to all ports', async () => {
      const pc1Iface = pc1.getInterfaces()[0];
      const receivedEvents: any[] = [];

      const listener = (event: any) => {
        if (event.type === 'frame_received') {
          receivedEvents.push(event);
        }
      };

      NetworkSimulator.addEventListener(listener);

      // Send ARP (broadcast) from PC1
      pc1.getNetworkStack().sendARPRequest('192.168.1.20', pc1Iface);

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 100));

      NetworkSimulator.removeEventListener(listener);

      // PC2 should have received the broadcast
      const pc2Received = receivedEvents.find(e =>
        e.destinationDeviceId === pc2.getId()
      );
      expect(pc2Received).toBeDefined();
    });
  });

  describe('ICMP Ping', () => {
    it('should send ping and receive reply', async () => {
      // First do ARP to get MAC addresses
      const pc1Iface = pc1.getInterfaces()[0];
      pc1.getNetworkStack().sendARPRequest('192.168.1.20', pc1Iface);

      // Wait for ARP to complete
      await new Promise(resolve => setTimeout(resolve, 200));

      // Now send ping
      const pingResult = await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Ping timeout')), 3000);

        pc1.getNetworkStack().sendPing('192.168.1.20', (response) => {
          clearTimeout(timeout);
          resolve(response);
        }, 2500);
      });

      expect(pingResult.success).toBe(true);
      expect(pingResult.sourceIP).toBe('192.168.1.20');
      expect(pingResult.rtt).toBeGreaterThanOrEqual(0);
    });

    it('should timeout when destination unreachable', async () => {
      // Try to ping non-existent IP
      const pingResult = await new Promise<any>((resolve) => {
        pc1.getNetworkStack().sendPing('192.168.1.99', (response) => {
          resolve(response);
        }, 500);
      });

      expect(pingResult.success).toBe(false);
      expect(pingResult.error).toBeDefined();
    });

    it('should fail ping when interface is down', async () => {
      const pc1Iface = pc1.getInterfaces()[0];

      // Bring interface down
      pc1.configureInterface(pc1Iface.id, { isUp: false });

      const pingResult = await new Promise<any>((resolve) => {
        pc1.getNetworkStack().sendPing('192.168.1.20', (response) => {
          resolve(response);
        }, 500);
      });

      expect(pingResult.success).toBe(false);
      expect(pingResult.error).toContain('unreachable');
    });
  });

  describe('Frame Delivery', () => {
    it('should not deliver frames to powered-off devices', async () => {
      const pc1Iface = pc1.getInterfaces()[0];

      // Power off PC2
      pc2.powerOff();

      const events: any[] = [];
      const listener = (event: any) => {
        events.push(event);
      };

      NetworkSimulator.addEventListener(listener);

      // Send ARP from PC1
      pc1.getNetworkStack().sendARPRequest('192.168.1.20', pc1Iface);

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 100));

      NetworkSimulator.removeEventListener(listener);

      // Should have a dropped frame event for PC2
      const droppedEvent = events.find(e =>
        e.type === 'frame_dropped' &&
        e.destinationDeviceId === pc2.getId() &&
        e.details?.reason === 'device_powered_off'
      );
      expect(droppedEvent).toBeDefined();
    });

    it('should not deliver frames to interfaces that are down', async () => {
      const pc1Iface = pc1.getInterfaces()[0];
      const pc2Iface = pc2.getInterfaces()[0];

      // Bring PC2 interface down
      pc2.configureInterface(pc2Iface.id, { isUp: false });

      const events: any[] = [];
      const listener = (event: any) => {
        events.push(event);
      };

      NetworkSimulator.addEventListener(listener);

      // Send ARP from PC1
      pc1.getNetworkStack().sendARPRequest('192.168.1.20', pc1Iface);

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 100));

      NetworkSimulator.removeEventListener(listener);

      // Should have a dropped frame event
      const droppedEvent = events.find(e =>
        e.type === 'frame_dropped' &&
        e.details?.reason === 'interface_down'
      );
      expect(droppedEvent).toBeDefined();
    });
  });

  describe('Multiple Ping Sequences', () => {
    it('should handle multiple consecutive pings', async () => {
      const pc1Iface = pc1.getInterfaces()[0];

      // First do ARP
      pc1.getNetworkStack().sendARPRequest('192.168.1.20', pc1Iface);

      // Wait for ARP
      await new Promise(resolve => setTimeout(resolve, 250));

      // Send multiple pings
      const totalPings = 3;
      const results: any[] = [];

      for (let i = 0; i < totalPings; i++) {
        const result = await new Promise<any>((resolve) => {
          pc1.getNetworkStack().sendPing('192.168.1.20', resolve, 2000);
        });
        results.push(result);
      }

      const successCount = results.filter(r => r.success).length;
      expect(successCount).toBe(totalPings);
    });
  });
});

describe('Direct Device Ping', () => {
  let pc1: BaseDevice;
  let pc2: BaseDevice;

  beforeEach(() => {
    pc1 = DeviceFactory.createDevice('linux-pc', 100, 100);
    pc2 = DeviceFactory.createDevice('linux-pc', 300, 100);

    pc1.powerOn();
    pc2.powerOn();

    const pc1Interfaces = pc1.getInterfaces();
    const pc2Interfaces = pc2.getInterfaces();

    // Configure IPs
    pc1.configureInterface(pc1Interfaces[0].id, {
      ipAddress: '10.0.0.1',
      subnetMask: '255.255.255.0',
      isUp: true
    });

    pc2.configureInterface(pc2Interfaces[0].id, {
      ipAddress: '10.0.0.2',
      subnetMask: '255.255.255.0',
      isUp: true
    });

    // Direct connection (no switch)
    const connections: Connection[] = [
      {
        id: 'direct-conn',
        type: 'ethernet',
        sourceDeviceId: pc1.getId(),
        sourceInterfaceId: pc1Interfaces[0].id,
        targetDeviceId: pc2.getId(),
        targetInterfaceId: pc2Interfaces[0].id,
        isActive: true
      }
    ];

    const devices = new Map<string, BaseDevice>();
    devices.set(pc1.getId(), pc1);
    devices.set(pc2.getId(), pc2);

    NetworkSimulator.initialize(devices, connections);
  });

  it('should ping directly connected device', async () => {
    const pc1Iface = pc1.getInterfaces()[0];

    // Do ARP first
    pc1.getNetworkStack().sendARPRequest('10.0.0.2', pc1Iface);

    // Wait for ARP
    await new Promise(resolve => setTimeout(resolve, 250));

    // Send ping
    const pingResult = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Ping timeout')), 3000);

      pc1.getNetworkStack().sendPing('10.0.0.2', (response) => {
        clearTimeout(timeout);
        resolve(response);
      }, 2500);
    });

    expect(pingResult.success).toBe(true);
    expect(pingResult.sourceIP).toBe('10.0.0.2');
  });
});
