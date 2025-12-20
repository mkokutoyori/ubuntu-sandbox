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
    it('should send ARP request for unknown MAC', (done) => {
      const pc1Iface = pc1.getInterfaces()[0];
      const events: any[] = [];

      NetworkSimulator.addEventListener((event) => {
        events.push(event);

        // Check for ARP request
        if (event.type === 'frame_sent' && event.frame?.etherType === ETHER_TYPE.ARP) {
          const arpPacket = event.frame.payload as ARPPacket;
          expect(arpPacket.opcode).toBe(ARPOpcode.REQUEST);
          expect(arpPacket.targetIP).toBe('192.168.1.20');
          done();
        }
      });

      // Trigger ARP by trying to send to unknown IP
      pc1.getNetworkStack().sendARPRequest('192.168.1.20', pc1Iface);
    });

    it('should learn MAC address from ARP request', () => {
      const pc1Iface = pc1.getInterfaces()[0];
      const pc2Iface = pc2.getInterfaces()[0];

      // Send ARP from PC1
      pc1.getNetworkStack().sendARPRequest('192.168.1.20', pc1Iface);

      // Wait a bit for processing
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          // PC2 should have learned PC1's MAC
          const pc2Arp = pc2.getNetworkStack().getARPTable();
          const pc1Entry = pc2Arp.find(e => e.ipAddress === '192.168.1.10');
          expect(pc1Entry).toBeDefined();
          expect(pc1Entry?.macAddress.toUpperCase()).toBe(pc1Iface.macAddress.toUpperCase());
          resolve();
        }, 50);
      });
    });

    it('should receive ARP reply and learn MAC', () => {
      const pc1Iface = pc1.getInterfaces()[0];

      // Send ARP from PC1
      pc1.getNetworkStack().sendARPRequest('192.168.1.20', pc1Iface);

      // Wait for ARP reply
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          // PC1 should now have PC2's MAC in its ARP table
          const pc1Arp = pc1.getNetworkStack().getARPTable();
          const pc2Entry = pc1Arp.find(e => e.ipAddress === '192.168.1.20');
          expect(pc2Entry).toBeDefined();
          resolve();
        }, 100);
      });
    });
  });

  describe('Switch MAC Learning', () => {
    it('should learn source MAC on ingress port', () => {
      const pc1Iface = pc1.getInterfaces()[0];

      // Send a frame from PC1
      pc1.getNetworkStack().sendARPRequest('192.168.1.20', pc1Iface);

      // Check switch MAC table
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const macTable = NetworkSimulator.getMACTable(switch1.getId());
          expect(macTable).not.toBeNull();
          expect(macTable!.length).toBeGreaterThan(0);

          // Should have PC1's MAC
          const pc1Entry = macTable!.find(e =>
            e.macAddress.toUpperCase() === pc1Iface.macAddress.toUpperCase()
          );
          expect(pc1Entry).toBeDefined();
          resolve();
        }, 50);
      });
    });

    it('should flood broadcast frames to all ports', () => {
      const pc1Iface = pc1.getInterfaces()[0];
      const receivedEvents: any[] = [];

      NetworkSimulator.addEventListener((event) => {
        if (event.type === 'frame_received') {
          receivedEvents.push(event);
        }
      });

      // Send ARP (broadcast) from PC1
      pc1.getNetworkStack().sendARPRequest('192.168.1.20', pc1Iface);

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          // PC2 should have received the broadcast
          const pc2Received = receivedEvents.find(e =>
            e.destinationDeviceId === pc2.getId()
          );
          expect(pc2Received).toBeDefined();
          resolve();
        }, 50);
      });
    });
  });

  describe('ICMP Ping', () => {
    it('should send ping and receive reply', () => {
      return new Promise<void>((resolve, reject) => {
        // First do ARP to get MAC addresses
        const pc1Iface = pc1.getInterfaces()[0];
        pc1.getNetworkStack().sendARPRequest('192.168.1.20', pc1Iface);

        setTimeout(() => {
          // Now send ping
          pc1.getNetworkStack().sendPing('192.168.1.20', (response) => {
            try {
              expect(response.success).toBe(true);
              expect(response.sourceIP).toBe('192.168.1.20');
              expect(response.rtt).toBeGreaterThanOrEqual(0);
              resolve();
            } catch (e) {
              reject(e);
            }
          }, 2000);
        }, 150);
      });
    });

    it('should timeout when destination unreachable', () => {
      return new Promise<void>((resolve, reject) => {
        // Try to ping non-existent IP
        pc1.getNetworkStack().sendPing('192.168.1.99', (response) => {
          try {
            expect(response.success).toBe(false);
            expect(response.error).toBeDefined();
            resolve();
          } catch (e) {
            reject(e);
          }
        }, 500);
      });
    });

    it('should fail ping when interface is down', () => {
      const pc1Iface = pc1.getInterfaces()[0];

      // Bring interface down
      pc1.configureInterface(pc1Iface.id, { isUp: false });

      return new Promise<void>((resolve, reject) => {
        pc1.getNetworkStack().sendPing('192.168.1.20', (response) => {
          try {
            expect(response.success).toBe(false);
            expect(response.error).toContain('unreachable');
            resolve();
          } catch (e) {
            reject(e);
          }
        }, 500);
      });
    });
  });

  describe('Frame Delivery', () => {
    it('should not deliver frames to powered-off devices', () => {
      const pc1Iface = pc1.getInterfaces()[0];

      // Power off PC2
      pc2.powerOff();

      const events: any[] = [];
      NetworkSimulator.addEventListener((event) => {
        events.push(event);
      });

      // Send ARP from PC1
      pc1.getNetworkStack().sendARPRequest('192.168.1.20', pc1Iface);

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          // Should have a dropped frame event for PC2
          const droppedEvent = events.find(e =>
            e.type === 'frame_dropped' &&
            e.destinationDeviceId === pc2.getId() &&
            e.details?.reason === 'device_powered_off'
          );
          expect(droppedEvent).toBeDefined();
          resolve();
        }, 50);
      });
    });

    it('should not deliver frames to interfaces that are down', () => {
      const pc1Iface = pc1.getInterfaces()[0];
      const pc2Iface = pc2.getInterfaces()[0];

      // Bring PC2 interface down
      pc2.configureInterface(pc2Iface.id, { isUp: false });

      const events: any[] = [];
      NetworkSimulator.addEventListener((event) => {
        events.push(event);
      });

      // Send ARP from PC1
      pc1.getNetworkStack().sendARPRequest('192.168.1.20', pc1Iface);

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          // Should have a dropped frame event
          const droppedEvent = events.find(e =>
            e.type === 'frame_dropped' &&
            e.details?.reason === 'interface_down'
          );
          expect(droppedEvent).toBeDefined();
          resolve();
        }, 50);
      });
    });
  });

  describe('Multiple Ping Sequences', () => {
    it('should handle multiple consecutive pings', () => {
      const pc1Iface = pc1.getInterfaces()[0];

      // First do ARP
      pc1.getNetworkStack().sendARPRequest('192.168.1.20', pc1Iface);

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          let successCount = 0;
          const totalPings = 3;

          for (let i = 0; i < totalPings; i++) {
            pc1.getNetworkStack().sendPing('192.168.1.20', (response) => {
              if (response.success) successCount++;

              if (successCount + (totalPings - i - 1) <= 0 || successCount === totalPings) {
                expect(successCount).toBe(totalPings);
                resolve();
              }
            }, 2000);
          }
        }, 200);
      });
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

  it('should ping directly connected device', () => {
    const pc1Iface = pc1.getInterfaces()[0];

    // Do ARP first
    pc1.getNetworkStack().sendARPRequest('10.0.0.2', pc1Iface);

    return new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        pc1.getNetworkStack().sendPing('10.0.0.2', (response) => {
          try {
            expect(response.success).toBe(true);
            expect(response.sourceIP).toBe('10.0.0.2');
            resolve();
          } catch (e) {
            reject(e);
          }
        }, 2000);
      }, 200);
    });
  });
});
