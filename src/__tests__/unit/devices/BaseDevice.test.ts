/**
 * Unit tests for BaseDevice abstract class
 * Following TDD approach - tests written first
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BaseDevice, DeviceType, DeviceStatus } from '@/domain/devices/BaseDevice';

// Concrete implementation for testing
class TestDevice extends BaseDevice {
  constructor(id: string, name: string) {
    super(id, name, 'test' as DeviceType);
  }

  public powerOn(): void {
    this.status = 'online';
  }

  public powerOff(): void {
    this.status = 'offline';
  }

  public reset(): void {
    this.status = 'online';
  }
}

describe('BaseDevice', () => {
  let device: TestDevice;

  beforeEach(() => {
    device = new TestDevice('device1', 'Test Device');
  });

  describe('construction', () => {
    it('should create device with id and name', () => {
      expect(device.getId()).toBe('device1');
      expect(device.getName()).toBe('Test Device');
    });

    it('should initialize with offline status', () => {
      expect(device.getStatus()).toBe('offline');
    });

    it('should have empty ports initially', () => {
      expect(device.getPorts()).toEqual([]);
    });
  });

  describe('port management', () => {
    it('should add port', () => {
      device.addPort('eth0');

      expect(device.getPorts()).toContain('eth0');
      expect(device.hasPort('eth0')).toBe(true);
    });

    it('should add multiple ports', () => {
      device.addPort('eth0');
      device.addPort('eth1');
      device.addPort('eth2');

      const ports = device.getPorts();
      expect(ports).toHaveLength(3);
      expect(ports).toContain('eth0');
      expect(ports).toContain('eth1');
      expect(ports).toContain('eth2');
    });

    it('should not add duplicate ports', () => {
      device.addPort('eth0');
      device.addPort('eth0');

      expect(device.getPorts()).toHaveLength(1);
    });

    it('should remove port', () => {
      device.addPort('eth0');
      device.addPort('eth1');

      device.removePort('eth0');

      expect(device.hasPort('eth0')).toBe(false);
      expect(device.hasPort('eth1')).toBe(true);
    });

    it('should check if port exists', () => {
      device.addPort('eth0');

      expect(device.hasPort('eth0')).toBe(true);
      expect(device.hasPort('eth1')).toBe(false);
    });
  });

  describe('status management', () => {
    it('should power on device', () => {
      device.powerOn();

      expect(device.getStatus()).toBe('online');
    });

    it('should power off device', () => {
      device.powerOn();
      device.powerOff();

      expect(device.getStatus()).toBe('offline');
    });

    it('should reset device', () => {
      device.powerOn();
      device.reset();

      expect(device.getStatus()).toBe('online');
    });

    it('should check if device is online', () => {
      expect(device.isOnline()).toBe(false);

      device.powerOn();
      expect(device.isOnline()).toBe(true);

      device.powerOff();
      expect(device.isOnline()).toBe(false);
    });
  });

  describe('metadata', () => {
    it('should set and get metadata', () => {
      device.setMetadata('vendor', 'Test Corp');
      device.setMetadata('model', 'TestDevice-1000');

      expect(device.getMetadata('vendor')).toBe('Test Corp');
      expect(device.getMetadata('model')).toBe('TestDevice-1000');
    });

    it('should return undefined for non-existent metadata', () => {
      expect(device.getMetadata('nonexistent')).toBeUndefined();
    });

    it('should get all metadata', () => {
      device.setMetadata('vendor', 'Test Corp');
      device.setMetadata('model', 'TestDevice-1000');

      const metadata = device.getAllMetadata();
      expect(metadata).toEqual({
        vendor: 'Test Corp',
        model: 'TestDevice-1000'
      });
    });
  });

  describe('device type', () => {
    it('should return device type', () => {
      expect(device.getType()).toBe('test');
    });

    it('should create PC device type', () => {
      const pc = new TestDevice('pc1', 'PC 1');
      expect(pc.getType()).toBeDefined();
    });
  });

  describe('serialization', () => {
    it('should export device to JSON', () => {
      device.addPort('eth0');
      device.addPort('eth1');
      device.setMetadata('vendor', 'Test Corp');
      device.powerOn();

      const exported = device.toJSON();

      expect(exported.id).toBe('device1');
      expect(exported.name).toBe('Test Device');
      expect(exported.type).toBe('test');
      expect(exported.status).toBe('online');
      expect(exported.ports).toEqual(['eth0', 'eth1']);
      expect(exported.metadata).toEqual({ vendor: 'Test Corp' });
    });
  });
});
