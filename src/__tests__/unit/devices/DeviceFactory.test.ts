/**
 * Unit tests for DeviceFactory
 */

import { describe, it, expect } from 'vitest';
import { DeviceFactory } from '@/domain/devices/DeviceFactory';
import { LinuxPC } from '@/domain/devices/LinuxPC';
import { WindowsPC } from '@/domain/devices/WindowsPC';
import { PC } from '@/domain/devices/PC';
import { Router } from '@/domain/devices/Router';
import { Switch } from '@/domain/devices/Switch';
import { Hub } from '@/domain/devices/Hub';
import { CiscoRouter } from '@/domain/devices/CiscoRouter';
import { CiscoSwitch } from '@/domain/devices/CiscoSwitch';
import { CiscoL3Switch } from '@/domain/devices/CiscoL3Switch';

describe('DeviceFactory', () => {
  describe('LinuxPC Creation', () => {
    it('should create LinuxPC with basic config', () => {
      const device = DeviceFactory.createDevice({
        type: 'linux-pc',
        name: 'Test Linux PC'
      });

      expect(device).toBeInstanceOf(LinuxPC);
      expect(device.getType()).toBe('linux-pc');
      expect(device.getName()).toBe('Test Linux PC');
    });

    it('should create LinuxPC with position', () => {
      const device = DeviceFactory.createDevice({
        type: 'linux-pc',
        name: 'Linux PC',
        x: 100,
        y: 200
      });

      const pos = device.getPosition();
      expect(pos.x).toBe(100);
      expect(pos.y).toBe(200);
    });

    it('should generate ID if not provided', () => {
      const device = DeviceFactory.createDevice({
        type: 'linux-pc',
        name: 'Linux PC'
      });

      expect(device.getId()).toBeTruthy();
      expect(device.getId()).toContain('linux-pc-');
    });

    it('should use provided ID', () => {
      const device = DeviceFactory.createDevice({
        type: 'linux-pc',
        id: 'custom-id',
        name: 'Linux PC'
      });

      expect(device.getId()).toBe('custom-id');
    });

    it('should power on by default', () => {
      const device = DeviceFactory.createDevice({
        type: 'linux-pc',
        name: 'Linux PC'
      });

      expect(device.isOnline()).toBe(true);
    });

    it('should not power on if explicitly disabled', () => {
      const device = DeviceFactory.createDevice({
        type: 'linux-pc',
        name: 'Linux PC',
        isPoweredOn: false
      });

      expect(device.isOnline()).toBe(false);
    });
  });

  describe('WindowsPC Creation', () => {
    it('should create WindowsPC', () => {
      const device = DeviceFactory.createDevice({
        type: 'windows-pc',
        name: 'Test Windows PC'
      });

      expect(device).toBeInstanceOf(WindowsPC);
      expect(device.getType()).toBe('windows-pc');
    });

    it('should create WindowsPC with custom hostname', () => {
      const device = DeviceFactory.createDevice({
        type: 'windows-pc',
        name: 'Windows PC',
        hostname: 'WIN-SERVER'
      });

      expect(device.getHostname()).toBe('WIN-SERVER');
    });
  });

  describe('Generic PC Creation', () => {
    it('should create generic PC', () => {
      const device = DeviceFactory.createDevice({
        type: 'pc',
        name: 'Generic PC'
      });

      expect(device).toBeInstanceOf(PC);
      expect(device.getType()).toBe('pc');
    });

    it('should configure generic PC position', () => {
      const device = DeviceFactory.createDevice({
        type: 'pc',
        name: 'PC',
        x: 50,
        y: 75
      });

      const pos = device.getPosition();
      expect(pos.x).toBe(50);
      expect(pos.y).toBe(75);
    });
  });

  describe('Router Creation', () => {
    it('should create generic router', () => {
      const device = DeviceFactory.createDevice({
        type: 'router',
        name: 'Test Router'
      });

      expect(device).toBeInstanceOf(Router);
      expect(device.getType()).toBe('router');
    });

    it('should create router with default 2 interfaces', () => {
      const device = DeviceFactory.createDevice({
        type: 'router',
        name: 'Router'
      }) as Router;

      const interfaces = device.getInterfaces();
      expect(interfaces.length).toBe(2);
    });

    it('should create CiscoRouter', () => {
      const device = DeviceFactory.createDevice({
        type: 'cisco-router',
        name: 'Cisco Router'
      });

      expect(device).toBeInstanceOf(CiscoRouter);
      expect(device.getType()).toBe('cisco-router');
    });
  });

  describe('Switch Creation', () => {
    it('should create generic switch', () => {
      const device = DeviceFactory.createDevice({
        type: 'switch',
        name: 'Test Switch'
      });

      expect(device).toBeInstanceOf(Switch);
      expect(device.getType()).toBe('switch');
    });

    it('should create switch with default 8 ports', () => {
      const device = DeviceFactory.createDevice({
        type: 'switch',
        name: 'Switch'
      });

      const ports = device.getPorts();
      expect(ports.length).toBe(8);
    });

    it('should create CiscoSwitch', () => {
      const device = DeviceFactory.createDevice({
        type: 'cisco-switch',
        name: 'Cisco Switch'
      });

      expect(device).toBeInstanceOf(CiscoSwitch);
      expect(device.getType()).toBe('cisco-switch');
    });

    it('should create CiscoL3Switch', () => {
      const device = DeviceFactory.createDevice({
        type: 'cisco-l3-switch',
        name: 'Cisco L3 Switch'
      });

      expect(device).toBeInstanceOf(CiscoL3Switch);
      expect(device.getType()).toBe('cisco-l3-switch');
    });
  });

  describe('Hub Creation', () => {
    it('should create hub', () => {
      const device = DeviceFactory.createDevice({
        type: 'hub',
        name: 'Test Hub'
      });

      expect(device).toBeInstanceOf(Hub);
      expect(device.getType()).toBe('hub');
    });

    it('should create hub with default 8 ports', () => {
      const device = DeviceFactory.createDevice({
        type: 'hub',
        name: 'Hub'
      });

      const ports = device.getPorts();
      expect(ports.length).toBe(8);
    });
  });

  describe('Error Handling', () => {
    it('should throw error for unknown device type', () => {
      expect(() => {
        DeviceFactory.createDevice({
          type: 'unknown-device' as any,
          name: 'Unknown'
        });
      }).toThrow('Unknown device type');
    });
  });

  describe('Bulk Creation', () => {
    it('should create multiple devices', () => {
      const configs = [
        { type: 'linux-pc' as const, name: 'PC1' },
        { type: 'windows-pc' as const, name: 'PC2' },
        { type: 'router' as const, name: 'R1' }
      ];

      const devices = DeviceFactory.createDevices(configs);

      expect(devices).toHaveLength(3);
      expect(devices[0]).toBeInstanceOf(LinuxPC);
      expect(devices[1]).toBeInstanceOf(WindowsPC);
      expect(devices[2]).toBeInstanceOf(Router);
    });

    it('should handle empty array', () => {
      const devices = DeviceFactory.createDevices([]);
      expect(devices).toHaveLength(0);
    });
  });

  describe('Configuration Preservation', () => {
    it('should preserve all config properties', () => {
      const config = {
        type: 'linux-pc' as const,
        id: 'test-123',
        name: 'Test Device',
        hostname: 'test-host',
        x: 150,
        y: 250,
        isPoweredOn: true
      };

      const device = DeviceFactory.createDevice(config);

      expect(device.getId()).toBe('test-123');
      expect(device.getName()).toBe('Test Device');
      expect(device.getHostname()).toBe('test-host');
      expect(device.getPosition()).toEqual({ x: 150, y: 250 });
      expect(device.isOnline()).toBe(true);
    });
  });

  describe('Auto-naming', () => {
    it('should use ID as name if name not provided', () => {
      const device = DeviceFactory.createDevice({
        type: 'pc',
        id: 'pc-auto-123'
      });

      expect(device.getName()).toBe('pc-auto-123');
    });
  });
});
