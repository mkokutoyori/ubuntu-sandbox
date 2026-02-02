/**
 * TDD RED Phase - Tests for network store connection flow
 *
 * Tests the enhanced connection workflow:
 * - User selects a source device → interface selector popup → picks interface + type
 * - User clicks target device → interface selector popup → picks target interface
 * - Connection is created with the chosen type and specific interfaces
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';

describe('networkStore connection flow', () => {
  beforeEach(() => {
    // Reset store between tests
    useNetworkStore.getState().clearAll();
  });

  describe('startConnecting with connection type', () => {
    it('should store connection type when starting connection', () => {
      const store = useNetworkStore.getState();

      // Add a device first
      const device = store.addDevice('linux-pc', 100, 100);

      store.startConnecting(device.id, 'eth0', 'ethernet');

      const state = useNetworkStore.getState();
      expect(state.isConnecting).toBe(true);
      expect(state.connectionSource).toEqual({
        deviceId: device.id,
        interfaceId: 'eth0',
        connectionType: 'ethernet'
      });
    });

    it('should store serial type when starting serial connection', () => {
      const store = useNetworkStore.getState();
      const device = store.addDevice('cisco-router', 100, 100);

      store.startConnecting(device.id, 'serial0/0', 'serial');

      const state = useNetworkStore.getState();
      expect(state.connectionSource?.connectionType).toBe('serial');
    });

    it('should default to ethernet when no type specified', () => {
      const store = useNetworkStore.getState();
      const device = store.addDevice('linux-pc', 100, 100);

      store.startConnecting(device.id, 'eth0');

      const state = useNetworkStore.getState();
      expect(state.connectionSource?.connectionType).toBe('ethernet');
    });
  });

  describe('finishConnecting with stored type', () => {
    it('should create connection with the type from startConnecting', () => {
      const store = useNetworkStore.getState();

      const pc1 = store.addDevice('linux-pc', 100, 100);
      const pc2 = store.addDevice('linux-pc', 300, 100);

      store.startConnecting(pc1.id, 'eth0', 'ethernet');
      store.finishConnecting(pc2.id, 'eth0');

      const state = useNetworkStore.getState();
      expect(state.connections).toHaveLength(1);
      expect(state.connections[0].type).toBe('ethernet');
      expect(state.connections[0].sourceInterfaceId).toBe('eth0');
      expect(state.connections[0].targetInterfaceId).toBe('eth0');
    });

    it('should create serial connection when serial type was selected', () => {
      const store = useNetworkStore.getState();

      const r1 = store.addDevice('cisco-router', 100, 100);
      const r2 = store.addDevice('cisco-router', 300, 100);

      // Find serial interfaces
      const r1Interfaces = r1.interfaces;
      const r2Interfaces = r2.interfaces;
      const r1Serial = r1Interfaces.find(i => i.type === 'serial');
      const r2Serial = r2Interfaces.find(i => i.type === 'serial');

      if (r1Serial && r2Serial) {
        store.startConnecting(r1.id, r1Serial.id, 'serial');
        store.finishConnecting(r2.id, r2Serial.id);

        const state = useNetworkStore.getState();
        expect(state.connections).toHaveLength(1);
        expect(state.connections[0].type).toBe('serial');
      }
    });

    it('should clear connecting state after finish', () => {
      const store = useNetworkStore.getState();

      const pc1 = store.addDevice('linux-pc', 100, 100);
      const pc2 = store.addDevice('linux-pc', 300, 100);

      store.startConnecting(pc1.id, 'eth0', 'ethernet');
      store.finishConnecting(pc2.id, 'eth0');

      const state = useNetworkStore.getState();
      expect(state.isConnecting).toBe(false);
      expect(state.connectionSource).toBeNull();
    });

    it('should not create connection to the same device', () => {
      const store = useNetworkStore.getState();
      const pc1 = store.addDevice('linux-pc', 100, 100);

      store.startConnecting(pc1.id, 'eth0', 'ethernet');
      store.finishConnecting(pc1.id, 'eth0');

      const state = useNetworkStore.getState();
      expect(state.connections).toHaveLength(0);
    });
  });

  describe('connection with specific interfaces', () => {
    it('should allow connecting to specific switch port', () => {
      const store = useNetworkStore.getState();

      const pc = store.addDevice('linux-pc', 100, 100);
      const sw = store.addDevice('cisco-switch', 300, 100);

      // User picks eth0 on PC, eth2 on switch (not first free!)
      store.startConnecting(pc.id, 'eth0', 'ethernet');
      store.finishConnecting(sw.id, sw.interfaces[2]?.id || 'eth2');

      const state = useNetworkStore.getState();
      expect(state.connections).toHaveLength(1);
      expect(state.connections[0].sourceInterfaceId).toBe('eth0');
      // Target should be the specifically chosen interface, not the first free one
      expect(state.connections[0].targetInterfaceId).toBe(sw.interfaces[2]?.id || 'eth2');
    });

    it('should prevent connecting to an already-used interface', () => {
      const store = useNetworkStore.getState();

      const pc1 = store.addDevice('linux-pc', 100, 100);
      const pc2 = store.addDevice('linux-pc', 300, 100);
      const sw = store.addDevice('cisco-switch', 200, 200);

      // Connect PC1 to sw eth0
      store.startConnecting(pc1.id, 'eth0', 'ethernet');
      const swPort0 = sw.interfaces[0]?.id || 'eth0';
      store.finishConnecting(sw.id, swPort0);

      expect(useNetworkStore.getState().connections).toHaveLength(1);

      // Try to connect PC2 to the same sw port → should fail
      store.startConnecting(pc2.id, 'eth0', 'ethernet');
      store.finishConnecting(sw.id, swPort0);

      expect(useNetworkStore.getState().connections).toHaveLength(1); // Still 1
    });
  });

  describe('connection instance creation', () => {
    it('should create EthernetConnection instance for ethernet type', () => {
      const store = useNetworkStore.getState();

      const pc1 = store.addDevice('linux-pc', 100, 100);
      const pc2 = store.addDevice('linux-pc', 300, 100);

      store.startConnecting(pc1.id, 'eth0', 'ethernet');
      store.finishConnecting(pc2.id, 'eth0');

      const conn = useNetworkStore.getState().connections[0];
      expect(conn.instance).toBeDefined();
      expect(conn.instance!.getType()).toBe('ethernet');
      expect(conn.instance!.getBandwidth()).toBe(1000); // 1000BASE-T default
    });

    it('should deactivate connection instance on removal', () => {
      const store = useNetworkStore.getState();

      const pc1 = store.addDevice('linux-pc', 100, 100);
      const pc2 = store.addDevice('linux-pc', 300, 100);

      store.startConnecting(pc1.id, 'eth0', 'ethernet');
      store.finishConnecting(pc2.id, 'eth0');

      const conn = useNetworkStore.getState().connections[0];
      const instance = conn.instance!;
      expect(instance.isActive()).toBe(true);

      store.removeConnection(conn.id);
      expect(instance.isActive()).toBe(false);
    });
  });
});
