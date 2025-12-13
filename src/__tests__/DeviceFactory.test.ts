/**
 * DeviceFactory Unit Tests
 * Tests device creation with proper position handling
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DeviceFactory } from '../devices/DeviceFactory';
import { DeviceType } from '../devices/common/types';

describe('DeviceFactory', () => {
  describe('Device Creation with Position', () => {
    const testCases: { type: DeviceType; name: string }[] = [
      { type: 'linux-pc', name: 'Linux PC' },
      { type: 'linux-server', name: 'Linux Server' },
      { type: 'windows-pc', name: 'Windows PC' },
      { type: 'windows-server', name: 'Windows Server' },
      { type: 'router-cisco', name: 'Cisco Router' },
      { type: 'switch-cisco', name: 'Cisco Switch' },
      { type: 'db-mysql', name: 'MySQL Database' },
      { type: 'db-postgres', name: 'PostgreSQL Database' },
      { type: 'db-oracle', name: 'Oracle Database' },
      { type: 'db-sqlserver', name: 'SQL Server Database' },
    ];

    testCases.forEach(({ type, name }) => {
      describe(`${name} (${type})`, () => {
        it('should create device at default position (0, 0) when no coordinates provided', () => {
          const device = DeviceFactory.createDevice(type);
          const position = device.getPosition();
          expect(position.x).toBe(0);
          expect(position.y).toBe(0);
        });

        it('should create device at specified position', () => {
          const x = 150;
          const y = 250;
          const device = DeviceFactory.createDevice(type, x, y);
          const position = device.getPosition();
          expect(position.x).toBe(x);
          expect(position.y).toBe(y);
        });

        it('should create device at exact drop position (non-integer)', () => {
          const x = 123.456;
          const y = 789.012;
          const device = DeviceFactory.createDevice(type, x, y);
          const position = device.getPosition();
          expect(position.x).toBe(x);
          expect(position.y).toBe(y);
        });

        it('should handle negative positions', () => {
          const x = -50;
          const y = -100;
          const device = DeviceFactory.createDevice(type, x, y);
          const position = device.getPosition();
          expect(position.x).toBe(x);
          expect(position.y).toBe(y);
        });

        it('should handle large positions', () => {
          const x = 10000;
          const y = 5000;
          const device = DeviceFactory.createDevice(type, x, y);
          const position = device.getPosition();
          expect(position.x).toBe(x);
          expect(position.y).toBe(y);
        });
      });
    });
  });

  describe('Position Updates', () => {
    it('should update position correctly after creation', () => {
      const device = DeviceFactory.createDevice('linux-pc', 100, 100);

      device.setPosition(200, 300);
      const position = device.getPosition();

      expect(position.x).toBe(200);
      expect(position.y).toBe(300);
    });

    it('should handle multiple position updates', () => {
      const device = DeviceFactory.createDevice('router-cisco', 0, 0);

      device.setPosition(100, 100);
      device.setPosition(200, 200);
      device.setPosition(300, 400);

      const position = device.getPosition();
      expect(position.x).toBe(300);
      expect(position.y).toBe(400);
    });
  });

  describe('Generic Device Positioning', () => {
    const genericTypes: DeviceType[] = [
      'mac-pc',
      'router-huawei',
      'switch-huawei',
      'firewall-fortinet',
      'firewall-cisco',
      'firewall-paloalto',
      'access-point',
      'cloud'
    ];

    genericTypes.forEach(type => {
      it(`should create ${type} at specified position`, () => {
        const x = 300;
        const y = 400;
        const device = DeviceFactory.createDevice(type, x, y);
        const position = device.getPosition();
        expect(position.x).toBe(x);
        expect(position.y).toBe(y);
      });
    });
  });

  describe('Terminal Support', () => {
    it('should correctly identify devices with terminal support', () => {
      const terminalDevices: DeviceType[] = [
        'linux-pc', 'linux-server',
        'windows-pc', 'windows-server',
        'router-cisco', 'switch-cisco',
        'db-mysql', 'db-postgres', 'db-oracle', 'db-sqlserver'
      ];

      terminalDevices.forEach(type => {
        expect(DeviceFactory.hasTerminalSupport(type)).toBe(true);
      });
    });

    it('should correctly identify devices without terminal support', () => {
      expect(DeviceFactory.hasTerminalSupport('cloud')).toBe(false);
    });
  });

  describe('Fully Implemented Devices', () => {
    it('should correctly identify fully implemented devices', () => {
      const implementedDevices: DeviceType[] = [
        'linux-pc', 'linux-server',
        'windows-pc', 'windows-server',
        'router-cisco', 'switch-cisco',
        'db-mysql', 'db-postgres', 'db-oracle', 'db-sqlserver'
      ];

      implementedDevices.forEach(type => {
        expect(DeviceFactory.isFullyImplemented(type)).toBe(true);
      });
    });

    it('should correctly identify not-yet-implemented devices', () => {
      const notImplemented: DeviceType[] = [
        'mac-pc', 'router-huawei', 'switch-huawei',
        'firewall-fortinet', 'firewall-cisco', 'firewall-paloalto',
        'access-point', 'cloud'
      ];

      notImplemented.forEach(type => {
        expect(DeviceFactory.isFullyImplemented(type)).toBe(false);
      });
    });
  });

  describe('Device Categories', () => {
    it('should categorize computers correctly', () => {
      expect(DeviceFactory.getDeviceCategory('linux-pc')).toBe('computers');
      expect(DeviceFactory.getDeviceCategory('windows-pc')).toBe('computers');
      expect(DeviceFactory.getDeviceCategory('mac-pc')).toBe('computers');
    });

    it('should categorize servers correctly', () => {
      expect(DeviceFactory.getDeviceCategory('linux-server')).toBe('servers');
      expect(DeviceFactory.getDeviceCategory('windows-server')).toBe('servers');
    });

    it('should categorize network devices correctly', () => {
      expect(DeviceFactory.getDeviceCategory('router-cisco')).toBe('network');
      expect(DeviceFactory.getDeviceCategory('switch-cisco')).toBe('network');
      expect(DeviceFactory.getDeviceCategory('router-huawei')).toBe('network');
      expect(DeviceFactory.getDeviceCategory('switch-huawei')).toBe('network');
    });

    it('should categorize databases correctly', () => {
      expect(DeviceFactory.getDeviceCategory('db-mysql')).toBe('databases');
      expect(DeviceFactory.getDeviceCategory('db-postgres')).toBe('databases');
      expect(DeviceFactory.getDeviceCategory('db-oracle')).toBe('databases');
      expect(DeviceFactory.getDeviceCategory('db-sqlserver')).toBe('databases');
    });

    it('should categorize security devices correctly', () => {
      expect(DeviceFactory.getDeviceCategory('firewall-fortinet')).toBe('security');
      expect(DeviceFactory.getDeviceCategory('firewall-cisco')).toBe('security');
      expect(DeviceFactory.getDeviceCategory('firewall-paloalto')).toBe('security');
    });
  });
});

describe('Drop Position Calculation', () => {
  /**
   * Simulates the drop position calculation from NetworkCanvas
   * This tests the formula: (clientX - rect.left - panX) / zoom
   */
  function calculateDropPosition(
    clientX: number,
    clientY: number,
    rectLeft: number,
    rectTop: number,
    panX: number,
    panY: number,
    zoom: number
  ): { x: number; y: number } {
    return {
      x: (clientX - rectLeft - panX) / zoom,
      y: (clientY - rectTop - panY) / zoom
    };
  }

  describe('with no pan and zoom = 1', () => {
    it('should calculate correct position at canvas origin', () => {
      const pos = calculateDropPosition(100, 100, 100, 100, 0, 0, 1);
      expect(pos.x).toBe(0);
      expect(pos.y).toBe(0);
    });

    it('should calculate correct position offset from origin', () => {
      const pos = calculateDropPosition(200, 250, 100, 100, 0, 0, 1);
      expect(pos.x).toBe(100);
      expect(pos.y).toBe(150);
    });
  });

  describe('with pan offset', () => {
    it('should account for positive pan values', () => {
      const pos = calculateDropPosition(300, 300, 100, 100, 50, 50, 1);
      expect(pos.x).toBe(150);
      expect(pos.y).toBe(150);
    });

    it('should account for negative pan values', () => {
      const pos = calculateDropPosition(200, 200, 100, 100, -50, -50, 1);
      expect(pos.x).toBe(150);
      expect(pos.y).toBe(150);
    });
  });

  describe('with zoom', () => {
    it('should scale position when zoomed in', () => {
      const pos = calculateDropPosition(300, 300, 100, 100, 0, 0, 2);
      expect(pos.x).toBe(100);
      expect(pos.y).toBe(100);
    });

    it('should scale position when zoomed out', () => {
      const pos = calculateDropPosition(200, 200, 100, 100, 0, 0, 0.5);
      expect(pos.x).toBe(200);
      expect(pos.y).toBe(200);
    });
  });

  describe('with pan and zoom combined', () => {
    it('should correctly combine pan and zoom', () => {
      // Drop at (400, 400), canvas starts at (100, 100)
      // Pan is (50, 50), zoom is 2
      // Formula: (400 - 100 - 50) / 2 = 125
      const pos = calculateDropPosition(400, 400, 100, 100, 50, 50, 2);
      expect(pos.x).toBe(125);
      expect(pos.y).toBe(125);
    });

    it('should handle complex scenarios', () => {
      // Real-world scenario: canvas at (250, 80), pan (100, 50), zoom 1.5
      // Drop at client (500, 380)
      // x = (500 - 250 - 100) / 1.5 = 100
      // y = (380 - 80 - 50) / 1.5 = 166.67
      const pos = calculateDropPosition(500, 380, 250, 80, 100, 50, 1.5);
      expect(pos.x).toBeCloseTo(100, 2);
      expect(pos.y).toBeCloseTo(166.67, 2);
    });
  });

  describe('Device drag within canvas', () => {
    /**
     * Simulates the drag position calculation from NetworkDevice
     * This tests the formula: (clientX - rect.left) / zoom - offset.x
     * Note: This needs to account for pan to match the drop formula
     */
    function calculateDragPosition(
      clientX: number,
      clientY: number,
      rectLeft: number,
      rectTop: number,
      panX: number,
      panY: number,
      zoom: number,
      offsetX: number = 0,
      offsetY: number = 0
    ): { x: number; y: number } {
      // The correct formula should match the drop calculation
      return {
        x: (clientX - rectLeft - panX) / zoom - offsetX,
        y: (clientY - rectTop - panY) / zoom - offsetY
      };
    }

    it('should calculate drag position consistently with drop position', () => {
      const dropPos = calculateDropPosition(300, 300, 100, 100, 50, 50, 1);
      const dragPos = calculateDragPosition(300, 300, 100, 100, 50, 50, 1, 0, 0);

      expect(dragPos.x).toBe(dropPos.x);
      expect(dragPos.y).toBe(dropPos.y);
    });

    it('should apply offset for grab point', () => {
      // When grabbing a device, we need to account for where we grabbed it
      const offset = { x: 10, y: 15 };
      const pos = calculateDragPosition(300, 300, 100, 100, 0, 0, 1, offset.x, offset.y);
      expect(pos.x).toBe(190);
      expect(pos.y).toBe(185);
    });
  });
});
