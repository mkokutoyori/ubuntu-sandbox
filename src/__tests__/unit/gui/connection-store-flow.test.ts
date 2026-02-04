/**
 * Tests for network store connection flow
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
      const device = store.addDevice('linux-pc', 100, 100);

      store.startConnecting(device.id, 'eth0', 'serial');

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

    it('should create connection between two PCs on specified interfaces', () => {
      const store = useNetworkStore.getState();

      const pc1 = store.addDevice('linux-pc', 100, 100);
      const pc2 = store.addDevice('linux-pc', 300, 100);

      store.startConnecting(pc1.id, 'eth1', 'ethernet');
      store.finishConnecting(pc2.id, 'eth1');

      const state = useNetworkStore.getState();
      expect(state.connections).toHaveLength(1);
      expect(state.connections[0].sourceInterfaceId).toBe('eth1');
      expect(state.connections[0].targetInterfaceId).toBe('eth1');
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
      const sw = store.addDevice('switch-cisco', 300, 100);

      // Connect to the third port (GigabitEthernet0/2)
      const targetPort = sw.interfaces[2]?.id || 'GigabitEthernet0/2';
      store.startConnecting(pc.id, 'eth0', 'ethernet');
      store.finishConnecting(sw.id, targetPort);

      const state = useNetworkStore.getState();
      expect(state.connections).toHaveLength(1);
      expect(state.connections[0].sourceInterfaceId).toBe('eth0');
      expect(state.connections[0].targetInterfaceId).toBe(targetPort);
    });

    it('should prevent connecting to an already-used interface', () => {
      const store = useNetworkStore.getState();

      const pc1 = store.addDevice('linux-pc', 100, 100);
      const pc2 = store.addDevice('linux-pc', 300, 100);
      const sw = store.addDevice('switch-cisco', 200, 200);

      // Connect PC1 to sw port 0
      const swPort0 = sw.interfaces[0]?.id || 'GigabitEthernet0/0';
      store.startConnecting(pc1.id, 'eth0', 'ethernet');
      store.finishConnecting(sw.id, swPort0);

      expect(useNetworkStore.getState().connections).toHaveLength(1);

      // Try to connect PC2 to the same sw port → should fail
      store.startConnecting(pc2.id, 'eth0', 'ethernet');
      store.finishConnecting(sw.id, swPort0);

      expect(useNetworkStore.getState().connections).toHaveLength(1); // Still 1
    });
  });

  describe('cable-based connection', () => {
    it('should create cable for ethernet connection', () => {
      const store = useNetworkStore.getState();

      const pc1 = store.addDevice('linux-pc', 100, 100);
      const pc2 = store.addDevice('linux-pc', 300, 100);

      store.startConnecting(pc1.id, 'eth0', 'ethernet');
      store.finishConnecting(pc2.id, 'eth0');

      const conn = useNetworkStore.getState().connections[0];
      expect(conn.cable).toBeDefined();
      expect(conn.cable.isConnected()).toBe(true);
    });

    it('should disconnect cable on connection removal', () => {
      const store = useNetworkStore.getState();

      const pc1 = store.addDevice('linux-pc', 100, 100);
      const pc2 = store.addDevice('linux-pc', 300, 100);

      store.startConnecting(pc1.id, 'eth0', 'ethernet');
      store.finishConnecting(pc2.id, 'eth0');

      const conn = useNetworkStore.getState().connections[0];
      const cable = conn.cable;
      expect(cable.isConnected()).toBe(true);

      store.removeConnection(conn.id);
      expect(cable.isConnected()).toBe(false);
    });
  });
});
