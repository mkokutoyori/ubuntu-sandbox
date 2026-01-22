/**
 * Unit tests for NetworkSimulator (Mediator pattern)
 * Following TDD approach - tests written first
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NetworkSimulator } from '@/domain/network/NetworkSimulator';
import { EthernetFrame, EtherType } from '@/domain/network/entities/EthernetFrame';
import { MACAddress } from '@/domain/network/value-objects/MACAddress';

// Mock network device for testing
class MockNetworkDevice {
  public id: string;
  public mac: MACAddress;
  public receivedFrames: EthernetFrame[] = [];

  constructor(id: string, mac: string) {
    this.id = id;
    this.mac = new MACAddress(mac);
  }

  receiveFrame(frame: EthernetFrame): void {
    this.receivedFrames.push(frame);
  }

  getMAC(): MACAddress {
    return this.mac;
  }

  getId(): string {
    return this.id;
  }
}

describe('NetworkSimulator', () => {
  let simulator: NetworkSimulator;

  beforeEach(() => {
    simulator = new NetworkSimulator();
  });

  describe('device registration', () => {
    it('should register a device', () => {
      const device = new MockNetworkDevice('device1', 'AA:BB:CC:DD:EE:FF');

      simulator.registerDevice(device.getId(), device.getMAC());

      expect(simulator.isDeviceRegistered(device.getId())).toBe(true);
    });

    it('should unregister a device', () => {
      const device = new MockNetworkDevice('device1', 'AA:BB:CC:DD:EE:FF');

      simulator.registerDevice(device.getId(), device.getMAC());
      expect(simulator.isDeviceRegistered(device.getId())).toBe(true);

      simulator.unregisterDevice(device.getId());
      expect(simulator.isDeviceRegistered(device.getId())).toBe(false);
    });

    it('should throw error when registering device with duplicate ID', () => {
      const device = new MockNetworkDevice('device1', 'AA:BB:CC:DD:EE:FF');

      simulator.registerDevice(device.getId(), device.getMAC());

      expect(() => {
        simulator.registerDevice(device.getId(), new MACAddress('11:22:33:44:55:66'));
      }).toThrow('Device already registered');
    });

    it('should throw error when registering device with duplicate MAC', () => {
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      simulator.registerDevice('device1', mac);

      expect(() => {
        simulator.registerDevice('device2', mac);
      }).toThrow('MAC address already in use');
    });
  });

  describe('port connections', () => {
    it('should connect two devices via ports', () => {
      const device1 = new MockNetworkDevice('device1', 'AA:BB:CC:DD:EE:FF');
      const device2 = new MockNetworkDevice('device2', '11:22:33:44:55:66');

      simulator.registerDevice(device1.getId(), device1.getMAC());
      simulator.registerDevice(device2.getId(), device2.getMAC());

      simulator.connectDevices(device1.getId(), 'eth0', device2.getId(), 'eth0');

      expect(simulator.areDevicesConnected(device1.getId(), device2.getId())).toBe(true);
    });

    it('should disconnect devices', () => {
      const device1 = new MockNetworkDevice('device1', 'AA:BB:CC:DD:EE:FF');
      const device2 = new MockNetworkDevice('device2', '11:22:33:44:55:66');

      simulator.registerDevice(device1.getId(), device1.getMAC());
      simulator.registerDevice(device2.getId(), device2.getMAC());
      simulator.connectDevices(device1.getId(), 'eth0', device2.getId(), 'eth0');

      simulator.disconnectDevices(device1.getId(), 'eth0');

      expect(simulator.areDevicesConnected(device1.getId(), device2.getId())).toBe(false);
    });

    it('should throw error when connecting non-existent device', () => {
      const device1 = new MockNetworkDevice('device1', 'AA:BB:CC:DD:EE:FF');

      simulator.registerDevice(device1.getId(), device1.getMAC());

      expect(() => {
        simulator.connectDevices(device1.getId(), 'eth0', 'nonexistent', 'eth0');
      }).toThrow('Device not found');
    });
  });

  describe('frame forwarding', () => {
    it('should forward unicast frame to connected device', () => {
      const device1 = new MockNetworkDevice('device1', 'AA:BB:CC:DD:EE:FF');
      const device2 = new MockNetworkDevice('device2', '11:22:33:44:55:66');

      simulator.registerDevice(device1.getId(), device1.getMAC());
      simulator.registerDevice(device2.getId(), device2.getMAC());
      simulator.connectDevices(device1.getId(), 'eth0', device2.getId(), 'eth0');

      const frame = new EthernetFrame({
        sourceMAC: device1.getMAC(),
        destinationMAC: device2.getMAC(),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      const callback = vi.fn();
      simulator.on('frameReceived', callback);

      simulator.sendFrame(device1.getId(), 'eth0', frame);

      expect(callback).toHaveBeenCalledWith({
        deviceId: device2.getId(),
        frame
      });
    });

    it('should broadcast frame to all connected devices except sender', () => {
      const device1 = new MockNetworkDevice('device1', 'AA:BB:CC:DD:EE:FF');
      const device2 = new MockNetworkDevice('device2', '11:22:33:44:55:66');
      const device3 = new MockNetworkDevice('device3', '22:33:44:55:66:77');

      simulator.registerDevice(device1.getId(), device1.getMAC());
      simulator.registerDevice(device2.getId(), device2.getMAC());
      simulator.registerDevice(device3.getId(), device3.getMAC());

      simulator.connectDevices(device1.getId(), 'eth0', device2.getId(), 'eth0');
      simulator.connectDevices(device1.getId(), 'eth1', device3.getId(), 'eth0');

      const frame = new EthernetFrame({
        sourceMAC: device1.getMAC(),
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      const callback = vi.fn();
      simulator.on('frameReceived', callback);

      simulator.sendFrame(device1.getId(), 'eth0', frame);

      // Should be called for device2 and device3, but not device1
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('should drop frame if destination not found', () => {
      const device1 = new MockNetworkDevice('device1', 'AA:BB:CC:DD:EE:FF');

      simulator.registerDevice(device1.getId(), device1.getMAC());

      const frame = new EthernetFrame({
        sourceMAC: device1.getMAC(),
        destinationMAC: new MACAddress('99:99:99:99:99:99'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      const callback = vi.fn();
      simulator.on('frameDropped', callback);

      simulator.sendFrame(device1.getId(), 'eth0', frame);

      expect(callback).toHaveBeenCalledWith({
        deviceId: device1.getId(),
        frame,
        reason: 'Destination not found'
      });
    });
  });

  describe('event system', () => {
    it('should emit deviceRegistered event', () => {
      const callback = vi.fn();
      simulator.on('deviceRegistered', callback);

      const device = new MockNetworkDevice('device1', 'AA:BB:CC:DD:EE:FF');
      simulator.registerDevice(device.getId(), device.getMAC());

      expect(callback).toHaveBeenCalledWith({
        deviceId: device.getId(),
        mac: device.getMAC()
      });
    });

    it('should emit deviceUnregistered event', () => {
      const callback = vi.fn();
      simulator.on('deviceUnregistered', callback);

      const device = new MockNetworkDevice('device1', 'AA:BB:CC:DD:EE:FF');
      simulator.registerDevice(device.getId(), device.getMAC());
      simulator.unregisterDevice(device.getId());

      expect(callback).toHaveBeenCalledWith({
        deviceId: device.getId()
      });
    });

    it('should remove event listener', () => {
      const callback = vi.fn();
      simulator.on('deviceRegistered', callback);
      simulator.off('deviceRegistered', callback);

      const device = new MockNetworkDevice('device1', 'AA:BB:CC:DD:EE:FF');
      simulator.registerDevice(device.getId(), device.getMAC());

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('statistics', () => {
    it('should track frame count', () => {
      const device1 = new MockNetworkDevice('device1', 'AA:BB:CC:DD:EE:FF');
      const device2 = new MockNetworkDevice('device2', '11:22:33:44:55:66');

      simulator.registerDevice(device1.getId(), device1.getMAC());
      simulator.registerDevice(device2.getId(), device2.getMAC());
      simulator.connectDevices(device1.getId(), 'eth0', device2.getId(), 'eth0');

      const frame = new EthernetFrame({
        sourceMAC: device1.getMAC(),
        destinationMAC: device2.getMAC(),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      simulator.sendFrame(device1.getId(), 'eth0', frame);
      simulator.sendFrame(device1.getId(), 'eth0', frame);

      const stats = simulator.getStatistics();
      expect(stats.totalFrames).toBe(2);
    });

    it('should reset statistics', () => {
      const device1 = new MockNetworkDevice('device1', 'AA:BB:CC:DD:EE:FF');

      simulator.registerDevice(device1.getId(), device1.getMAC());

      const frame = new EthernetFrame({
        sourceMAC: device1.getMAC(),
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      simulator.sendFrame(device1.getId(), 'eth0', frame);

      simulator.resetStatistics();

      const stats = simulator.getStatistics();
      expect(stats.totalFrames).toBe(0);
    });
  });
});
