/**
 * Network Store - State management for network topology
 *
 * Uses the new equipment-driven architecture:
 * - Equipment classes handle their own frame processing
 * - Cables connect Ports for direct device-to-device communication
 * - No central NetworkSimulator mediator
 */

import { create } from 'zustand';
import {
  Equipment, Cable, Port,
  DeviceType, ConnectionType,
  createDevice, resetDeviceCounters,
  generateId, resetCounters,
  Logger,
} from '@/network';

/**
 * Network interface config for UI rendering
 */
export interface NetworkInterfaceConfig {
  id: string;
  name: string;
  type: 'ethernet' | 'serial' | 'console' | 'fiber';
  ipAddress?: string;
  subnetMask?: string;
  macAddress?: string;
  isUp?: boolean;
}

/**
 * Connection record (UI representation of a Cable)
 */
export interface Connection {
  id: string;
  type: ConnectionType;
  sourceDeviceId: string;
  sourceInterfaceId: string;
  targetDeviceId: string;
  targetInterfaceId: string;
  isActive: boolean;
  cable: Cable;
}

/**
 * UI representation of a device (for rendering)
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
  instance: Equipment;
}

interface NetworkState {
  deviceInstances: Map<string, Equipment>;
  connections: Connection[];
  selectedDeviceId: string | null;
  selectedConnectionId: string | null;
  isConnecting: boolean;
  connectionSource: { deviceId: string; interfaceId: string; connectionType: ConnectionType } | null;
  zoom: number;
  panX: number;
  panY: number;

  // Device actions
  addDevice: (type: DeviceType, x: number, y: number) => NetworkDeviceUI;
  removeDevice: (id: string) => void;
  updateDevice: (id: string, updates: { name?: string; hostname?: string; isPoweredOn?: boolean; x?: number; y?: number }) => void;
  moveDevice: (id: string, x: number, y: number) => void;
  selectDevice: (id: string | null) => void;
  getDevice: (id: string) => Equipment | undefined;
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
  startConnecting: (deviceId: string, interfaceId: string, connectionType?: ConnectionType) => void;
  finishConnecting: (deviceId: string, interfaceId: string) => void;
  cancelConnecting: () => void;

  // View actions
  setZoom: (zoom: number) => void;
  setPan: (x: number, y: number) => void;

  // Utility
  clearSelection: () => void;
  clearAll: () => void;
}

/**
 * Convert an Equipment instance to a UI representation
 */
function deviceToUI(device: Equipment): NetworkDeviceUI {
  const pos = device.getPosition();
  const ports = device.getPorts();

  const interfaces: NetworkInterfaceConfig[] = ports.map((port: Port) => ({
    id: port.getName(),
    name: port.getName(),
    type: port.getType() as NetworkInterfaceConfig['type'],
    ipAddress: port.getIPAddress()?.toString(),
    subnetMask: port.getSubnetMask()?.toString(),
    macAddress: port.getMAC().toString(),
    isUp: port.getIsUp(),
  }));

  return {
    id: device.getId(),
    type: device.getType(),
    name: device.getName(),
    hostname: device.getHostname(),
    x: pos.x,
    y: pos.y,
    interfaces,
    isPoweredOn: device.getIsPoweredOn(),
    instance: device,
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
    const device = createDevice(type, x, y);

    set(state => {
      const newInstances = new Map(state.deviceInstances);
      newInstances.set(device.getId(), device);
      return { deviceInstances: newInstances };
    });

    return deviceToUI(device);
  },

  removeDevice: (id) => {
    const state = get();

    // Disconnect all cables involving this device
    const connectionsToRemove = state.connections.filter(
      c => c.sourceDeviceId === id || c.targetDeviceId === id
    );
    for (const conn of connectionsToRemove) {
      conn.cable.disconnect();
    }

    set(state => {
      const newInstances = new Map(state.deviceInstances);
      newInstances.delete(id);

      return {
        deviceInstances: newInstances,
        connections: state.connections.filter(
          c => c.sourceDeviceId !== id && c.targetDeviceId !== id
        ),
        selectedDeviceId: state.selectedDeviceId === id ? null : state.selectedDeviceId,
      };
    });
  },

  updateDevice: (id, updates) => {
    const state = get();
    const device = state.deviceInstances.get(id);
    if (!device) return;

    if (updates.name !== undefined) device.setName(updates.name);
    if (updates.hostname !== undefined) device.setHostname(updates.hostname);
    if (updates.isPoweredOn !== undefined) {
      if (updates.isPoweredOn) device.powerOn();
      else device.powerOff();
    }
    if (updates.x !== undefined && updates.y !== undefined) {
      device.setPosition(updates.x, updates.y);
    }

    set(state => ({ deviceInstances: new Map(state.deviceInstances) }));
  },

  moveDevice: (id, x, y) => {
    const state = get();
    const device = state.deviceInstances.get(id);
    if (device) {
      device.setPosition(x, y);
      set(state => ({ deviceInstances: new Map(state.deviceInstances) }));
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

    // Find the actual ports on the devices
    const sourceDevice = state.deviceInstances.get(sourceDeviceId);
    const targetDevice = state.deviceInstances.get(targetDeviceId);
    if (!sourceDevice || !targetDevice) return null;

    const sourcePort = sourceDevice.getPort(sourceInterfaceId);
    const targetPort = targetDevice.getPort(targetInterfaceId);
    if (!sourcePort || !targetPort) return null;

    // Create a Cable and connect the ports
    const connId = generateId();
    const cable = new Cable(connId);
    cable.connect(sourcePort, targetPort);

    const connection: Connection = {
      id: connId,
      type,
      sourceDeviceId,
      sourceInterfaceId,
      targetDeviceId,
      targetInterfaceId,
      isActive: true,
      cable,
    };

    set(state => ({
      connections: [...state.connections, connection],
    }));

    return connection;
  },

  removeConnection: (id) => {
    set(state => {
      const conn = state.connections.find(c => c.id === id);
      if (conn) {
        conn.cable.disconnect();
      }

      return {
        connections: state.connections.filter(c => c.id !== id),
        selectedConnectionId: state.selectedConnectionId === id ? null : state.selectedConnectionId,
      };
    });
  },

  selectConnection: (id) => {
    set({ selectedConnectionId: id, selectedDeviceId: null });
  },

  startConnecting: (deviceId, interfaceId, connectionType = 'ethernet') => {
    set({
      isConnecting: true,
      connectionSource: { deviceId, interfaceId, connectionType },
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
        interfaceId,
        state.connectionSource.connectionType,
      );
    }

    set({ isConnecting: false, connectionSource: null });
  },

  cancelConnecting: () => {
    set({ isConnecting: false, connectionSource: null });
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
    // Disconnect all cables
    const state = get();
    for (const conn of state.connections) {
      conn.cable.disconnect();
    }

    resetDeviceCounters();
    resetCounters();
    Logger.reset();

    set({
      deviceInstances: new Map(),
      connections: [],
      selectedDeviceId: null,
      selectedConnectionId: null,
      isConnecting: false,
      connectionSource: null,
    });
  },
}));

export type { NetworkState };
