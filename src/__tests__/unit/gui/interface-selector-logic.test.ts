/**
 * TDD RED Phase - Tests for InterfaceSelectorPopover logic
 *
 * Tests the logic that powers the interface selector popup:
 * - Building the list of selectable interfaces
 * - Grouping interfaces by type
 * - Determining which connection types are available
 * - Validating interface selection
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildInterfaceList,
  groupInterfacesByType,
  InterfaceListItem
} from '@/components/network/interface-selector-logic';
import type { ConnectionType } from '@/network';
import type { Connection, NetworkInterfaceConfig } from '@/store/networkStore';

describe('interface-selector-logic', () => {
  const pcInterfaces: NetworkInterfaceConfig[] = [
    { id: 'eth0', name: 'eth0', type: 'ethernet', ipAddress: '192.168.1.10', macAddress: '00:11:22:33:44:55' },
  ];

  const routerInterfaces: NetworkInterfaceConfig[] = [
    { id: 'eth0', name: 'GigabitEthernet0/0', type: 'ethernet' },
    { id: 'eth1', name: 'GigabitEthernet0/1', type: 'ethernet' },
    { id: 'serial0/0', name: 'Serial0/0', type: 'serial' },
    { id: 'serial0/1', name: 'Serial0/1', type: 'serial' },
    { id: 'console0', name: 'Console0', type: 'console' },
  ];

  const switchInterfaces: NetworkInterfaceConfig[] = [
    { id: 'eth0', name: 'GigabitEthernet0/0', type: 'ethernet' },
    { id: 'eth1', name: 'GigabitEthernet0/1', type: 'ethernet' },
    { id: 'eth2', name: 'GigabitEthernet0/2', type: 'ethernet' },
    { id: 'eth3', name: 'GigabitEthernet0/3', type: 'ethernet' },
    { id: 'console0', name: 'Console0', type: 'console' },
  ];

  // ── buildInterfaceList ──────────────────────────────────────────────

  describe('buildInterfaceList', () => {
    it('should mark all interfaces as available when no connections', () => {
      const list = buildInterfaceList('router-1', routerInterfaces, []);
      expect(list).toHaveLength(5);
      expect(list.every(item => item.isAvailable)).toBe(true);
      expect(list.every(item => !item.isConnected)).toBe(true);
    });

    it('should mark connected interface as unavailable', () => {
      const connections: Connection[] = [{
        id: 'conn-1', type: 'ethernet',
        sourceDeviceId: 'router-1', sourceInterfaceId: 'eth0',
        targetDeviceId: 'switch-1', targetInterfaceId: 'eth0',
        isActive: true
      }];

      const list = buildInterfaceList('router-1', routerInterfaces, connections);
      const eth0 = list.find(item => item.id === 'eth0')!;
      expect(eth0.isConnected).toBe(true);
      expect(eth0.isAvailable).toBe(false);

      // Others remain available
      const eth1 = list.find(item => item.id === 'eth1')!;
      expect(eth1.isAvailable).toBe(true);
    });

    it('should include connection info for connected interfaces', () => {
      const connections: Connection[] = [{
        id: 'conn-1', type: 'ethernet',
        sourceDeviceId: 'router-1', sourceInterfaceId: 'eth0',
        targetDeviceId: 'switch-1', targetInterfaceId: 'eth0',
        isActive: true
      }];

      const list = buildInterfaceList('router-1', routerInterfaces, connections);
      const eth0 = list.find(item => item.id === 'eth0')!;
      expect(eth0.connectedTo).toBeDefined();
      expect(eth0.connectedTo!.deviceId).toBe('switch-1');
      expect(eth0.connectedTo!.interfaceId).toBe('eth0');
    });

    it('should filter by connection type when specified', () => {
      const list = buildInterfaceList('router-1', routerInterfaces, [], 'serial');
      const available = list.filter(item => item.isAvailable);
      expect(available).toHaveLength(2);
      expect(available.every(item => item.type === 'serial')).toBe(true);
    });

    it('should show all interfaces but disable incompatible ones when filtering', () => {
      const list = buildInterfaceList('router-1', routerInterfaces, [], 'serial');
      // Ethernet interfaces should be in the list but not available for serial connection
      const ethItems = list.filter(item => item.type === 'ethernet');
      expect(ethItems.length).toBeGreaterThan(0);
      expect(ethItems.every(item => !item.isAvailable)).toBe(true);
    });
  });

  // ── groupInterfacesByType ───────────────────────────────────────────

  describe('groupInterfacesByType', () => {
    it('should group router interfaces by type', () => {
      const list = buildInterfaceList('router-1', routerInterfaces, []);
      const groups = groupInterfacesByType(list);

      expect(groups).toHaveProperty('ethernet');
      expect(groups).toHaveProperty('serial');
      expect(groups).toHaveProperty('console');
      expect(groups.ethernet).toHaveLength(2);
      expect(groups.serial).toHaveLength(2);
      expect(groups.console).toHaveLength(1);
    });

    it('should group switch interfaces correctly', () => {
      const list = buildInterfaceList('switch-1', switchInterfaces, []);
      const groups = groupInterfacesByType(list);

      expect(groups.ethernet).toHaveLength(4);
      expect(groups.console).toHaveLength(1);
      expect(groups.serial).toBeUndefined();
    });

    it('should preserve availability status in groups', () => {
      const connections: Connection[] = [{
        id: 'conn-1', type: 'ethernet',
        sourceDeviceId: 'switch-1', sourceInterfaceId: 'eth0',
        targetDeviceId: 'pc-1', targetInterfaceId: 'eth0',
        isActive: true
      }];

      const list = buildInterfaceList('switch-1', switchInterfaces, connections);
      const groups = groupInterfacesByType(list);

      const connectedEth = groups.ethernet!.find(i => i.id === 'eth0')!;
      expect(connectedEth.isConnected).toBe(true);

      const freeEth = groups.ethernet!.find(i => i.id === 'eth1')!;
      expect(freeEth.isAvailable).toBe(true);
    });
  });
});
