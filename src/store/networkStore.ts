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
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { getDefaultEventBus } from '@/events/EventBus';

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
  cable: Cable;
}

export function buildConnection(
  sourceDevice: Equipment,
  sourceInterfaceId: string,
  targetDevice: Equipment,
  targetInterfaceId: string,
  type: ConnectionType,
): Connection | null {
  const sourcePort = sourceDevice.getPort(sourceInterfaceId);
  const targetPort = targetDevice.getPort(targetInterfaceId);
  if (!sourcePort || !targetPort) return null;

  const connId = generateId();
  const cable = new Cable(connId);
  cable.connect(sourcePort, targetPort);

  return {
    id: connId,
    type,
    sourceDeviceId: sourceDevice.getId(),
    sourceInterfaceId,
    targetDeviceId: targetDevice.getId(),
    targetInterfaceId,
    cable,
  };
}

export function isConnectionActive(connection: Connection): boolean {
  const portA = connection.cable.getPortA();
  const portB = connection.cable.getPortB();
  if (!portA || !portB) return false;
  if (!portA.getIsUp() || !portB.getIsUp()) return false;
  const state = useNetworkStore.getState();
  const source = state.deviceInstances.get(connection.sourceDeviceId);
  const target = state.deviceInstances.get(connection.targetDeviceId);
  return (source?.getIsPoweredOn() ?? true) && (target?.getIsPoweredOn() ?? true);
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
  /** Monotonic change signal for in-place instance mutations (drag). */
  revision: number;
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
 * Referential stability for UI snapshots (GAP §11.2).
 *
 * `getDevices()` used to rebuild every NetworkDeviceUI object (reading
 * all ports/IPs/MACs of every device) on each render, and `moveDevice`
 * recreated the whole instances Map per mousemove pixel — so dragging
 * one node re-rendered every node and connection on the canvas.
 *
 * The fix is NOT a blind cache (device state mutates outside the store,
 * e.g. an IP configured in a terminal): each call still derives a fresh
 * snapshot from the live Equipment, but returns the PREVIOUS object when
 * nothing visible changed. Memoised children (NetworkDevice) and zustand
 * selector equality then prune the re-render storm, while any real
 * change — wherever it came from — is still picked up on the next render.
 */
const uiSnapshots = new WeakMap<Equipment, NetworkDeviceUI>();
let devicesArraySnapshot: NetworkDeviceUI[] = [];

function sameInterfaces(a: NetworkInterfaceConfig[], b: NetworkInterfaceConfig[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.id !== y.id || x.name !== y.name || x.type !== y.type
      || x.ipAddress !== y.ipAddress || x.subnetMask !== y.subnetMask
      || x.macAddress !== y.macAddress || x.isUp !== y.isUp) return false;
  }
  return true;
}

function sameUI(a: NetworkDeviceUI, b: NetworkDeviceUI): boolean {
  return a.id === b.id && a.type === b.type && a.name === b.name
    && a.hostname === b.hostname && a.x === b.x && a.y === b.y
    && a.isPoweredOn === b.isPoweredOn
    && sameInterfaces(a.interfaces, b.interfaces);
}

/** Fresh snapshot, but referentially stable while nothing changed. */
function stableDeviceUI(device: Equipment): NetworkDeviceUI {
  const next = deviceToUI(device);
  const prev = uiSnapshots.get(device);
  if (prev && sameUI(prev, next)) return prev;
  uiSnapshots.set(device, next);
  return next;
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
  revision: 0,
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
    const device = state.deviceInstances.get(id);

    // Disconnect all cables involving this device
    const connectionsToRemove = state.connections.filter(
      c => c.sourceDeviceId === id || c.targetDeviceId === id
    );
    for (const conn of connectionsToRemove) {
      conn.cable.disconnect();
    }

    // Notify the rest of the system BEFORE the device disappears from the
    // store, so subscribers (TerminalManager, supervisors) can read final
    // state. We emit `device.removed` (user-initiated) alongside the bus's
    // own `device.deregistered`, which the registry will fire below.
    if (device) {
      getDefaultEventBus().publish({
        topic: 'device.removed',
        payload: {
          id: device.getId(),
          name: device.getName(),
          wasPoweredOn: device.getIsPoweredOn(),
        },
      });
      // Power-down side effects (services, supervisors) before dropping the
      // registry entry so dependent listeners observe a clean shutdown.
      if (device.getIsPoweredOn()) {
        try { device.powerOff(); } catch { /* never block removal */ }
      }
      EquipmentRegistry.getInstance().deregister(id);
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
      // Notify subscribers without copying the whole Map on every
      // mousemove pixel — the position lives on the instance; the
      // revision tick is just the change signal.
      set(state => ({ revision: state.revision + 1 }));
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
    let unchanged = devicesArraySnapshot.length === state.deviceInstances.size;
    let i = 0;
    state.deviceInstances.forEach(device => {
      const ui = stableDeviceUI(device);
      if (unchanged && devicesArraySnapshot[i] !== ui) unchanged = false;
      devices.push(ui);
      i++;
    });
    if (unchanged) return devicesArraySnapshot;
    devicesArraySnapshot = devices;
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

    const sourceDevice = state.deviceInstances.get(sourceDeviceId);
    const targetDevice = state.deviceInstances.get(targetDeviceId);
    if (!sourceDevice || !targetDevice) return null;

    const connection = buildConnection(
      sourceDevice, sourceInterfaceId, targetDevice, targetInterfaceId, type);
    if (!connection) return null;

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

    // Power down every device first, so each one emits its own
    // `device.power-off` event (services stop, supervisors detach), then
    // clear the registry which fires `registry.cleared` for the terminal
    // manager and other reactive subscribers.
    for (const dev of state.deviceInstances.values()) {
      if (dev.getIsPoweredOn()) {
        try { dev.powerOff(); } catch { /* swallow */ }
      }
    }
    EquipmentRegistry.getInstance().clear();

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
