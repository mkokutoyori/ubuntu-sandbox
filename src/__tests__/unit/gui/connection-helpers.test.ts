/**
 * TDD RED Phase - Tests for GUI connection helper functions
 *
 * These helpers extract pure logic from React components for testability:
 * - getAvailableInterfaces: filters out already-connected interfaces
 * - getCompatibleConnectionTypes: determines valid cable types between two devices
 * - getConnectionLabel: returns a human-readable label for a connection
 * - getInterfaceDisplayInfo: returns formatted interface info for the selector
 */

import { describe, it, expect } from 'vitest';
import {
  getAvailableInterfaces,
  getCompatibleConnectionTypes,
  getConnectionLabel,
  getInterfaceDisplayInfo,
  getConnectionEndpointLabel
} from '@/components/network/connection-helpers';
import type { ConnectionType } from '@/network';
import type { Connection, NetworkInterfaceConfig } from '@/store/networkStore';

describe('connection-helpers', () => {
  // ── getAvailableInterfaces ──────────────────────────────────────────

  describe('getAvailableInterfaces', () => {
    const interfaces: NetworkInterfaceConfig[] = [
      { id: 'eth0', name: 'eth0', type: 'ethernet' },
      { id: 'eth1', name: 'eth1', type: 'ethernet' },
      { id: 'eth2', name: 'eth2', type: 'ethernet' },
      { id: 'serial0/0', name: 'serial0/0', type: 'serial' },
      { id: 'console0', name: 'console0', type: 'console' },
    ];

    const deviceId = 'device-1';

    it('should return all interfaces when none are connected', () => {
      const result = getAvailableInterfaces(deviceId, interfaces, []);
      expect(result).toHaveLength(5);
    });

    it('should exclude interfaces connected as source', () => {
      const connections: Connection[] = [
        {
          id: 'conn-1', type: 'ethernet',
          sourceDeviceId: 'device-1', sourceInterfaceId: 'eth0',
          targetDeviceId: 'device-2', targetInterfaceId: 'eth0',
          isActive: true
        }
      ];
      const result = getAvailableInterfaces(deviceId, interfaces, connections);
      expect(result).toHaveLength(4);
      expect(result.find(i => i.id === 'eth0')).toBeUndefined();
    });

    it('should exclude interfaces connected as target', () => {
      const connections: Connection[] = [
        {
          id: 'conn-1', type: 'ethernet',
          sourceDeviceId: 'device-2', sourceInterfaceId: 'eth0',
          targetDeviceId: 'device-1', targetInterfaceId: 'eth1',
          isActive: true
        }
      ];
      const result = getAvailableInterfaces(deviceId, interfaces, connections);
      expect(result).toHaveLength(4);
      expect(result.find(i => i.id === 'eth1')).toBeUndefined();
    });

    it('should exclude multiple connected interfaces', () => {
      const connections: Connection[] = [
        {
          id: 'conn-1', type: 'ethernet',
          sourceDeviceId: 'device-1', sourceInterfaceId: 'eth0',
          targetDeviceId: 'device-2', targetInterfaceId: 'eth0',
          isActive: true
        },
        {
          id: 'conn-2', type: 'ethernet',
          sourceDeviceId: 'device-3', sourceInterfaceId: 'eth0',
          targetDeviceId: 'device-1', targetInterfaceId: 'eth1',
          isActive: true
        }
      ];
      const result = getAvailableInterfaces(deviceId, interfaces, connections);
      expect(result).toHaveLength(3);
      expect(result.map(i => i.id)).toEqual(['eth2', 'serial0/0', 'console0']);
    });

    it('should return empty array when all interfaces are connected', () => {
      const connections: Connection[] = interfaces.map((iface, i) => ({
        id: `conn-${i}`, type: 'ethernet' as ConnectionType,
        sourceDeviceId: 'device-1', sourceInterfaceId: iface.id,
        targetDeviceId: `device-${i + 2}`, targetInterfaceId: 'eth0',
        isActive: true
      }));
      const result = getAvailableInterfaces(deviceId, interfaces, connections);
      expect(result).toHaveLength(0);
    });

    it('should filter by connection type when specified', () => {
      const result = getAvailableInterfaces(deviceId, interfaces, [], 'serial');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('serial0/0');
    });

    it('should filter ethernet interfaces by connection type', () => {
      const result = getAvailableInterfaces(deviceId, interfaces, [], 'ethernet');
      expect(result).toHaveLength(3);
      expect(result.every(i => i.type === 'ethernet')).toBe(true);
    });
  });

  // ── getCompatibleConnectionTypes ────────────────────────────────────

  describe('getCompatibleConnectionTypes', () => {
    it('should return ethernet for PC-to-Switch connection', () => {
      const sourceInterfaces: NetworkInterfaceConfig[] = [
        { id: 'eth0', name: 'eth0', type: 'ethernet' }
      ];
      const targetInterfaces: NetworkInterfaceConfig[] = [
        { id: 'eth0', name: 'eth0', type: 'ethernet' },
        { id: 'eth1', name: 'eth1', type: 'ethernet' },
      ];
      const types = getCompatibleConnectionTypes(sourceInterfaces, targetInterfaces);
      expect(types).toContain('ethernet');
    });

    it('should return serial when both devices have serial interfaces', () => {
      const sourceInterfaces: NetworkInterfaceConfig[] = [
        { id: 'eth0', name: 'eth0', type: 'ethernet' },
        { id: 'serial0/0', name: 'serial0/0', type: 'serial' },
      ];
      const targetInterfaces: NetworkInterfaceConfig[] = [
        { id: 'eth0', name: 'eth0', type: 'ethernet' },
        { id: 'serial0/0', name: 'serial0/0', type: 'serial' },
      ];
      const types = getCompatibleConnectionTypes(sourceInterfaces, targetInterfaces);
      expect(types).toContain('ethernet');
      expect(types).toContain('serial');
    });

    it('should return console when both devices have console interfaces', () => {
      const sourceInterfaces: NetworkInterfaceConfig[] = [
        { id: 'console0', name: 'console0', type: 'console' }
      ];
      const targetInterfaces: NetworkInterfaceConfig[] = [
        { id: 'console0', name: 'console0', type: 'console' }
      ];
      const types = getCompatibleConnectionTypes(sourceInterfaces, targetInterfaces);
      expect(types).toContain('console');
    });

    it('should not return serial if only one side has serial', () => {
      const sourceInterfaces: NetworkInterfaceConfig[] = [
        { id: 'eth0', name: 'eth0', type: 'ethernet' },
        { id: 'serial0/0', name: 'serial0/0', type: 'serial' },
      ];
      const targetInterfaces: NetworkInterfaceConfig[] = [
        { id: 'eth0', name: 'eth0', type: 'ethernet' },
      ];
      const types = getCompatibleConnectionTypes(sourceInterfaces, targetInterfaces);
      expect(types).toContain('ethernet');
      expect(types).not.toContain('serial');
    });

    it('should return empty array if no compatible types exist', () => {
      const sourceInterfaces: NetworkInterfaceConfig[] = [
        { id: 'serial0/0', name: 'serial0/0', type: 'serial' },
      ];
      const targetInterfaces: NetworkInterfaceConfig[] = [
        { id: 'console0', name: 'console0', type: 'console' },
      ];
      const types = getCompatibleConnectionTypes(sourceInterfaces, targetInterfaces);
      expect(types).toHaveLength(0);
    });
  });

  // ── getConnectionLabel ──────────────────────────────────────────────

  describe('getConnectionLabel', () => {
    it('should return "Ethernet" for ethernet connections', () => {
      expect(getConnectionLabel('ethernet')).toBe('Ethernet');
    });

    it('should return "Serial" for serial connections', () => {
      expect(getConnectionLabel('serial')).toBe('Serial');
    });

    it('should return "Console" for console connections', () => {
      expect(getConnectionLabel('console')).toBe('Console');
    });
  });

  // ── getInterfaceDisplayInfo ─────────────────────────────────────────

  describe('getInterfaceDisplayInfo', () => {
    it('should return formatted info for ethernet interface with IP', () => {
      const iface: NetworkInterfaceConfig = {
        id: 'eth0', name: 'eth0', type: 'ethernet',
        ipAddress: '192.168.1.10', subnetMask: '255.255.255.0',
        macAddress: '00:11:22:33:44:55'
      };
      const info = getInterfaceDisplayInfo(iface, false);
      expect(info.name).toBe('eth0');
      expect(info.type).toBe('ethernet');
      expect(info.ipAddress).toBe('192.168.1.10');
      expect(info.isConnected).toBe(false);
      expect(info.isAvailable).toBe(true);
    });

    it('should mark connected interface as unavailable', () => {
      const iface: NetworkInterfaceConfig = {
        id: 'eth0', name: 'eth0', type: 'ethernet'
      };
      const info = getInterfaceDisplayInfo(iface, true);
      expect(info.isConnected).toBe(true);
      expect(info.isAvailable).toBe(false);
    });

    it('should show serial interface type', () => {
      const iface: NetworkInterfaceConfig = {
        id: 'serial0/0', name: 'serial0/0', type: 'serial'
      };
      const info = getInterfaceDisplayInfo(iface, false);
      expect(info.type).toBe('serial');
    });
  });

  // ── getConnectionEndpointLabel ──────────────────────────────────────

  describe('getConnectionEndpointLabel', () => {
    const connection: Connection = {
      id: 'conn-1', type: 'ethernet',
      sourceDeviceId: 'dev-1', sourceInterfaceId: 'eth0',
      targetDeviceId: 'dev-2', targetInterfaceId: 'eth1',
      isActive: true
    };

    it('should return source interface name for source endpoint', () => {
      const label = getConnectionEndpointLabel(connection, 'source');
      expect(label).toBe('eth0');
    });

    it('should return target interface name for target endpoint', () => {
      const label = getConnectionEndpointLabel(connection, 'target');
      expect(label).toBe('eth1');
    });
  });
});
