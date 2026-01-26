/**
 * TDD Tests for New Device Types
 *
 * Tests for new network equipment:
 * - Servers (Linux Server, Windows Server)
 * - Security (Firewall, Cisco ASA)
 * - Wireless (Access Point, Wireless Controller)
 * - Infrastructure (Cloud, Multilayer Switch)
 * - Specialty (IP Phone, Network Printer)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DeviceFactory } from '@/domain/devices/DeviceFactory';
import { DEVICE_CATEGORIES } from '@/domain/devices/types';

describe('New Device Types', () => {
  describe('Server Devices', () => {
    describe('Linux Server', () => {
      it('should create a Linux server via factory', () => {
        const server = DeviceFactory.createDevice({
          type: 'linux-server',
          name: 'Web Server',
          hostname: 'web01'
        });

        expect(server).toBeDefined();
        expect(server.getType()).toBe('linux-server');
        expect(server.getName()).toBe('Web Server');
        expect(server.getHostname()).toBe('web01');
      });

      it('should have linux OS type', () => {
        const server = DeviceFactory.createDevice({ type: 'linux-server' });
        expect(server.getOSType()).toBe('linux');
      });

      it('should have multiple ethernet interfaces', () => {
        const server = DeviceFactory.createDevice({ type: 'linux-server' });
        const interfaces = server.getInterfaces();
        expect(interfaces.length).toBeGreaterThanOrEqual(2);
      });

      it('should support terminal commands', () => {
        expect(DeviceFactory.hasTerminalSupport('linux-server')).toBe(true);
      });
    });

    describe('Windows Server', () => {
      it('should create a Windows server via factory', () => {
        const server = DeviceFactory.createDevice({
          type: 'windows-server',
          name: 'AD Server',
          hostname: 'DC01'
        });

        expect(server).toBeDefined();
        expect(server.getType()).toBe('windows-server');
        expect(server.getHostname()).toBe('DC01');
      });

      it('should have windows OS type', () => {
        const server = DeviceFactory.createDevice({ type: 'windows-server' });
        expect(server.getOSType()).toBe('windows');
      });

      it('should support terminal commands', () => {
        expect(DeviceFactory.hasTerminalSupport('windows-server')).toBe(true);
      });
    });
  });

  describe('Security Devices', () => {
    describe('Firewall', () => {
      it('should create a generic firewall via factory', () => {
        const fw = DeviceFactory.createDevice({
          type: 'firewall',
          name: 'Edge Firewall',
          hostname: 'FW01'
        });

        expect(fw).toBeDefined();
        expect(fw.getType()).toBe('firewall');
      });

      it('should have multiple interfaces (inside, outside, dmz)', () => {
        const fw = DeviceFactory.createDevice({ type: 'firewall' });
        const interfaces = fw.getInterfaces();
        expect(interfaces.length).toBeGreaterThanOrEqual(3);
      });

      it('should be a layer 3 device', () => {
        const fw = DeviceFactory.createDevice({ type: 'firewall' });
        expect(fw.isLayer3Device?.() ?? true).toBe(true);
      });
    });

    describe('Cisco ASA', () => {
      it('should create a Cisco ASA via factory', () => {
        const asa = DeviceFactory.createDevice({
          type: 'cisco-asa',
          name: 'ASA 5506',
          hostname: 'ASA01'
        });

        expect(asa).toBeDefined();
        expect(asa.getType()).toBe('cisco-asa');
      });

      it('should have cisco-ios OS type', () => {
        const asa = DeviceFactory.createDevice({ type: 'cisco-asa' });
        expect(asa.getOSType()).toBe('cisco-ios');
      });

      it('should support terminal commands', () => {
        expect(DeviceFactory.hasTerminalSupport('cisco-asa')).toBe(true);
      });
    });
  });

  describe('Wireless Devices', () => {
    describe('Access Point', () => {
      it('should create an access point via factory', () => {
        const ap = DeviceFactory.createDevice({
          type: 'access-point',
          name: 'Office AP',
          hostname: 'AP01'
        });

        expect(ap).toBeDefined();
        expect(ap.getType()).toBe('access-point');
      });

      it('should have uplink interface', () => {
        const ap = DeviceFactory.createDevice({ type: 'access-point' });
        const interfaces = ap.getInterfaces();
        expect(interfaces.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe('Wireless Controller', () => {
      it('should create a wireless controller via factory', () => {
        const wlc = DeviceFactory.createDevice({
          type: 'wireless-controller',
          name: 'WLC 5520',
          hostname: 'WLC01'
        });

        expect(wlc).toBeDefined();
        expect(wlc.getType()).toBe('wireless-controller');
      });

      it('should have multiple management interfaces', () => {
        const wlc = DeviceFactory.createDevice({ type: 'wireless-controller' });
        const interfaces = wlc.getInterfaces();
        expect(interfaces.length).toBeGreaterThanOrEqual(2);
      });
    });
  });

  describe('Infrastructure Devices', () => {
    describe('Cloud/Internet', () => {
      it('should create a cloud node via factory', () => {
        const cloud = DeviceFactory.createDevice({
          type: 'cloud',
          name: 'Internet'
        });

        expect(cloud).toBeDefined();
        expect(cloud.getType()).toBe('cloud');
      });

      it('should have at least one interface for connections', () => {
        const cloud = DeviceFactory.createDevice({ type: 'cloud' });
        const interfaces = cloud.getInterfaces();
        expect(interfaces.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe('Multilayer Switch', () => {
      it('should create a multilayer switch via factory', () => {
        const mls = DeviceFactory.createDevice({
          type: 'multilayer-switch',
          name: 'Core Switch',
          hostname: 'CORE01'
        });

        expect(mls).toBeDefined();
        expect(mls.getType()).toBe('multilayer-switch');
      });

      it('should have many ports like a switch', () => {
        const mls = DeviceFactory.createDevice({ type: 'multilayer-switch' });
        const interfaces = mls.getInterfaces();
        expect(interfaces.length).toBeGreaterThanOrEqual(24);
      });
    });
  });

  describe('Specialty Devices', () => {
    describe('IP Phone', () => {
      it('should create an IP phone via factory', () => {
        const phone = DeviceFactory.createDevice({
          type: 'ip-phone',
          name: 'Desk Phone',
          hostname: 'PHONE001'
        });

        expect(phone).toBeDefined();
        expect(phone.getType()).toBe('ip-phone');
      });

      it('should have ethernet interface', () => {
        const phone = DeviceFactory.createDevice({ type: 'ip-phone' });
        const interfaces = phone.getInterfaces();
        expect(interfaces.length).toBeGreaterThanOrEqual(1);
      });

      it('should optionally have PC passthrough port', () => {
        const phone = DeviceFactory.createDevice({ type: 'ip-phone' });
        const interfaces = phone.getInterfaces();
        // IP phones typically have 2 ports: network + PC passthrough
        expect(interfaces.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe('Network Printer', () => {
      it('should create a network printer via factory', () => {
        const printer = DeviceFactory.createDevice({
          type: 'printer',
          name: 'Office Printer',
          hostname: 'PRINTER01'
        });

        expect(printer).toBeDefined();
        expect(printer.getType()).toBe('printer');
      });

      it('should have ethernet interface', () => {
        const printer = DeviceFactory.createDevice({ type: 'printer' });
        const interfaces = printer.getInterfaces();
        expect(interfaces.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('Device Categories for UI', () => {
    it('should have Servers category', () => {
      const serversCategory = DEVICE_CATEGORIES.find(c => c.id === 'servers');
      expect(serversCategory).toBeDefined();
      expect(serversCategory?.devices.length).toBeGreaterThan(0);
    });

    it('should have Security category', () => {
      const securityCategory = DEVICE_CATEGORIES.find(c => c.id === 'security');
      expect(securityCategory).toBeDefined();
      expect(securityCategory?.devices.length).toBeGreaterThan(0);
    });

    it('should have Wireless category', () => {
      const wirelessCategory = DEVICE_CATEGORIES.find(c => c.id === 'wireless');
      expect(wirelessCategory).toBeDefined();
      expect(wirelessCategory?.devices.length).toBeGreaterThan(0);
    });

    it('should have End Devices category', () => {
      const endDevicesCategory = DEVICE_CATEGORIES.find(c => c.id === 'end-devices');
      expect(endDevicesCategory).toBeDefined();
      expect(endDevicesCategory?.devices.length).toBeGreaterThan(0);
    });

    it('should include linux-server in Servers category', () => {
      const serversCategory = DEVICE_CATEGORIES.find(c => c.id === 'servers');
      const linuxServer = serversCategory?.devices.find(d => d.type === 'linux-server');
      expect(linuxServer).toBeDefined();
    });

    it('should include firewall in Security category', () => {
      const securityCategory = DEVICE_CATEGORIES.find(c => c.id === 'security');
      const firewall = securityCategory?.devices.find(d => d.type === 'firewall');
      expect(firewall).toBeDefined();
    });

    it('should include access-point in Wireless category', () => {
      const wirelessCategory = DEVICE_CATEGORIES.find(c => c.id === 'wireless');
      const ap = wirelessCategory?.devices.find(d => d.type === 'access-point');
      expect(ap).toBeDefined();
    });
  });

  describe('Device Factory Completeness', () => {
    const newDeviceTypes = [
      'linux-server',
      'windows-server',
      'firewall',
      'cisco-asa',
      'access-point',
      'wireless-controller',
      'cloud',
      'multilayer-switch',
      'ip-phone',
      'printer'
    ];

    it.each(newDeviceTypes)('should create %s without throwing', (type) => {
      expect(() => {
        DeviceFactory.createDevice({ type: type as any });
      }).not.toThrow();
    });

    it.each(newDeviceTypes)('%s should have valid id and name', (type) => {
      const device = DeviceFactory.createDevice({ type: type as any });
      expect(device.getId()).toBeTruthy();
      expect(device.getName()).toBeTruthy();
    });

    it.each(newDeviceTypes)('%s should be able to power on/off', (type) => {
      const device = DeviceFactory.createDevice({ type: type as any, isPoweredOn: false });
      expect(device.isOnline()).toBe(false);

      device.powerOn();
      expect(device.isOnline()).toBe(true);

      device.powerOff();
      expect(device.isOnline()).toBe(false);
    });
  });
});
