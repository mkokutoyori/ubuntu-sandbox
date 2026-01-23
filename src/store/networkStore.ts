/**
 * Network Store - State management for network topology
 * Uses device class instances from Sprint 1
 */

import { create } from 'zustand';
import {
  BaseDevice,
  DeviceFactory,
  DeviceType,
  DeviceConfig,
  Connection,
  ConnectionType,
  NetworkInterfaceConfig,
  generateId,
  resetDeviceCounters
} from '@/domain/devices';

/**
 * UI representation of a device (for rendering)
 * Contains both the device class instance and UI-specific data
 */
export interface NetworkDeviceUI {
  id: string;
  type: DeviceType;
  name: string;
  hostname: string;
  x: number;
  y: number;
  interfaces: NetworkInterfaceConfig[];
  isPoweredOn: boolean;
  isSelected?: boolean;
  // Reference to the actual device instance
  instance: BaseDevice;
}

interface NetworkState {
  // Device instances mapped by ID
  deviceInstances: Map<string, BaseDevice>;
  // Connections between devices
  connections: Connection[];
  // UI state
  selectedDeviceId: string | null;
  selectedConnectionId: string | null;
  isConnecting: boolean;
  connectionSource: { deviceId: string; interfaceId: string } | null;
  zoom: number;
  panX: number;
  panY: number;

  // Device actions
  addDevice: (type: DeviceType, x: number, y: number) => NetworkDeviceUI;
  removeDevice: (id: string) => void;
  updateDevice: (id: string, updates: Partial<DeviceConfig>) => void;
  moveDevice: (id: string, x: number, y: number) => void;
  selectDevice: (id: string | null) => void;
  getDevice: (id: string) => BaseDevice | undefined;
  getDevices: () => NetworkDeviceUI[];

  // Connection actions
  addConnection: (
    sourceDeviceId: string,
    sourceInterfaceId: string,
    targetDeviceId: string,
    targetInterfaceId: string,
    type?: ConnectionType
  ) => Connection | null;
  removeConnection: (id: string) => void;
  selectConnection: (id: string | null) => void;

  // Connection mode
  startConnecting: (deviceId: string, interfaceId: string) => void;
  finishConnecting: (deviceId: string, interfaceId: string) => void;
  cancelConnecting: () => void;

  // View actions
  setZoom: (zoom: number) => void;
  setPan: (x: number, y: number) => void;

  // Utility actions
  clearSelection: () => void;
  clearAll: () => void;
}

/**
 * Convert a BaseDevice instance to a UI representation
 */
function deviceToUI(device: BaseDevice): NetworkDeviceUI {
  const pos = device.getPosition();

  // Get interfaces and convert to config format
  let interfaces: NetworkInterfaceConfig[] = [];
  if ('getInterfaces' in device && typeof (device as any).getInterfaces === 'function') {
    const deviceInterfaces = (device as any).getInterfaces();
    interfaces = deviceInterfaces.map((iface: any) => ({
      id: iface.getName(),
      name: iface.getName(),
      type: 'ethernet' as const,
      ipAddress: iface.getIPAddress()?.toString(),
      subnetMask: iface.getSubnetMask()?.toString(),
    }));
  }

  return {
    id: device.getId(),
    type: device.getType(),
    name: device.getName(),
    hostname: device.getHostname(),
    x: pos.x,
    y: pos.y,
    interfaces: interfaces,
    isPoweredOn: device.getIsPoweredOn(),
    instance: device
  };
}

export const useNetworkStore = create<NetworkState>((set, get) => ({
  deviceInstances: new Map(),
  connections: [],
  selectedDeviceId: null,
  selectedConnectionId: null,
  isConnecting: false,
  connectionSource: null,
  zoom: 1,
  panX: 0,
  panY: 0,

  addDevice: (type, x, y) => {
    // Create a new device instance using the factory
    const device = DeviceFactory.createDevice({
      type: type,
      x: x,
      y: y
    });

    // Store the instance
    set(state => {
      const newInstances = new Map(state.deviceInstances);
      newInstances.set(device.getId(), device);
      return { deviceInstances: newInstances };
    });

    return deviceToUI(device);
  },

  removeDevice: (id) => {
    set(state => {
      const newInstances = new Map(state.deviceInstances);
      newInstances.delete(id);

      return {
        deviceInstances: newInstances,
        connections: state.connections.filter(
          c => c.sourceDeviceId !== id && c.targetDeviceId !== id
        ),
        selectedDeviceId: state.selectedDeviceId === id ? null : state.selectedDeviceId
      };
    });
  },

  updateDevice: (id, updates) => {
    const state = get();
    const device = state.deviceInstances.get(id);

    if (!device) return;

    // Update the device instance
    if (updates.name !== undefined) {
      device.setName(updates.name);
    }
    if (updates.hostname !== undefined) {
      device.setHostname(updates.hostname);
    }
    if (updates.isPoweredOn !== undefined) {
      if (updates.isPoweredOn) {
        device.powerOn();
      } else {
        device.powerOff();
      }
    }
    if (updates.x !== undefined && updates.y !== undefined) {
      device.setPosition(updates.x, updates.y);
    }

    // Trigger re-render by updating the map reference
    set(state => ({
      deviceInstances: new Map(state.deviceInstances)
    }));
  },

  moveDevice: (id, x, y) => {
    const state = get();
    const device = state.deviceInstances.get(id);

    if (device) {
      device.setPosition(x, y);
      set(state => ({
        deviceInstances: new Map(state.deviceInstances)
      }));
    }
  },

  selectDevice: (id) => {
    set({ selectedDeviceId: id, selectedConnectionId: null });
  },

  getDevice: (id) => {
    return get().deviceInstances.get(id);
  },

  getDevices: () => {
    const state = get();
    const devices: NetworkDeviceUI[] = [];

    state.deviceInstances.forEach(device => {
      devices.push(deviceToUI(device));
    });

    return devices;
  },

  addConnection: (sourceDeviceId, sourceInterfaceId, targetDeviceId, targetInterfaceId, type = 'ethernet') => {
    const state = get();

    // Check if connection already exists on these interfaces
    const exists = state.connections.some(c =>
      (c.sourceDeviceId === sourceDeviceId && c.sourceInterfaceId === sourceInterfaceId) ||
      (c.targetDeviceId === sourceDeviceId && c.targetInterfaceId === sourceInterfaceId) ||
      (c.sourceDeviceId === targetDeviceId && c.sourceInterfaceId === targetInterfaceId) ||
      (c.targetDeviceId === targetDeviceId && c.targetInterfaceId === targetInterfaceId)
    );

    if (exists) return null;

    const connection: Connection = {
      id: generateId(),
      type,
      sourceDeviceId,
      sourceInterfaceId,
      targetDeviceId,
      targetInterfaceId,
      isActive: true
    };

    set(state => ({
      connections: [...state.connections, connection]
    }));

    return connection;
  },

  removeConnection: (id) => {
    set(state => ({
      connections: state.connections.filter(c => c.id !== id),
      selectedConnectionId: state.selectedConnectionId === id ? null : state.selectedConnectionId
    }));
  },

  selectConnection: (id) => {
    set({ selectedConnectionId: id, selectedDeviceId: null });
  },

  startConnecting: (deviceId, interfaceId) => {
    set({
      isConnecting: true,
      connectionSource: { deviceId, interfaceId }
    });
  },

  finishConnecting: (deviceId, interfaceId) => {
    const state = get();
    if (!state.connectionSource) return;

    if (state.connectionSource.deviceId !== deviceId) {
      get().addConnection(
        state.connectionSource.deviceId,
        state.connectionSource.interfaceId,
        deviceId,
        interfaceId
      );
    }

    set({
      isConnecting: false,
      connectionSource: null
    });
  },

  cancelConnecting: () => {
    set({
      isConnecting: false,
      connectionSource: null
    });
  },

  setZoom: (zoom) => {
    set({ zoom: Math.max(0.25, Math.min(2, zoom)) });
  },

  setPan: (x, y) => {
    set({ panX: x, panY: y });
  },

  clearSelection: () => {
    set({ selectedDeviceId: null, selectedConnectionId: null });
  },

  clearAll: () => {
    resetDeviceCounters();
    set({
      deviceInstances: new Map(),
      connections: [],
      selectedDeviceId: null,
      selectedConnectionId: null,
      isConnecting: false,
      connectionSource: null
    });
  }
}));

// Export types
export type { NetworkState, Connection };
