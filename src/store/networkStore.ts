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
  /** Line state — `shutdown` / `ip link set down`. Not the whole story. */
  isUp?: boolean;
  /**
   * Signal on the wire. False when the cable is out, but also when the
   * far end stopped driving it — a shut peer port, a peer switched off.
   * Without this the UI could only tell whether a cable was drawn, which
   * is not what "connected" means (docs/PRD-Link-State.md §6).
   */
  hasCarrier?: boolean;
  /** Line state, admin state and carrier all agreeing. */
  isOperational?: boolean;
  acceptsCable: boolean;
  hasSocket: boolean;
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
  if (!cable.connect(sourcePort, targetPort)) return null;

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

/**
 * Undo/redo history (rapport 09 audit, item #54) — covers exactly the 5
 * graph-shape actions the audit names: add/remove device, add/remove
 * connection, move. Restoring a removed device keeps the SAME Equipment
 * instance alive (see doRestoreDevice) rather than recreating it, since
 * a device's CLI-configured state (IPs, routes, users, …) lives entirely
 * on that object — there is no separate "config" struct to snapshot.
 * Deliberately out of scope: `updateDevice` (rename/hostname/power —
 * not named by the audit, and "undo a power toggle" is ambiguous once
 * other commands may have run since); `clearAll`/Import/Open, which
 * already bypass these actions via direct `setState` and instead clear
 * the history stacks (a fresh document resets undo history, same as
 * most editors).
 */
export type HistoryCommand =
  | { kind: 'addDevice'; device: Equipment }
  | { kind: 'removeDevice'; device: Equipment; connections: Connection[] }
  | { kind: 'move'; deviceId: string; from: { x: number; y: number }; to: { x: number; y: number } }
  | { kind: 'addConnection'; connection: Connection }
  | { kind: 'removeConnection'; connection: Connection };

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
  historyPast: HistoryCommand[];
  historyFuture: HistoryCommand[];

  // Device actions
  addDevice: (type: DeviceType, x: number, y: number) => NetworkDeviceUI;
  removeDevice: (id: string) => void;
  updateDevice: (id: string, updates: { name?: string; hostname?: string; isPoweredOn?: boolean; x?: number; y?: number }) => void;
  moveDevice: (id: string, x: number, y: number) => void;
  /** Records one undo-able move for a gesture already applied via moveDevice
   *  (drag) or about to be applied by the caller (keyboard nudge) — see
   *  each call site for which. A no-op if `from`/`to` are equal. */
  commitMove: (id: string, from: { x: number; y: number }, to: { x: number; y: number }) => void;
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

  // History
  undo: () => void;
  redo: () => void;

  // Utility
  clearSelection: () => void;
  clearAll: () => void;
  replaceTopology: (deviceInstances: Map<string, Equipment>, connections: Connection[]) => void;
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
      || x.macAddress !== y.macAddress || x.isUp !== y.isUp
      // Left out, the snapshot would be judged unchanged when only the
      // carrier moved, and the canvas would keep the stale one forever.
      || x.hasCarrier !== y.hasCarrier || x.isOperational !== y.isOperational
      || x.acceptsCable !== y.acceptsCable || x.hasSocket !== y.hasSocket) return false;
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
    hasCarrier: port.hasCarrier(),
    isOperational: port.isOperationallyUp(),
    acceptsCable: port.acceptsCable(),
    hasSocket: port.hasSocket(),
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

/** Reconnect a previously-disconnected connection's cable to the same
 *  (device, interface) pair it originally used — a no-op if either
 *  device or port is gone (e.g. also removed since). */
function tearDownCanvas(
  state: { connections: Connection[]; deviceInstances: Map<string, Equipment> },
  scope: 'clear' | 'replace',
): void {
  for (const conn of state.connections) {
    conn.cable.disconnect();
  }

  for (const dev of state.deviceInstances.values()) {
    if (dev.getIsPoweredOn()) {
      try { dev.powerOff(); } catch { /* swallow */ }
    }
  }

  const registry = EquipmentRegistry.getInstance();
  if (scope === 'clear') {
    registry.clear();
    return;
  }
  for (const id of state.deviceInstances.keys()) registry.deregister(id);
}

function reconnectCable(connection: Connection, deviceInstances: Map<string, Equipment>): boolean {
  const source = deviceInstances.get(connection.sourceDeviceId);
  const target = deviceInstances.get(connection.targetDeviceId);
  if (!source || !target) return false;
  const sourcePort = source.getPort(connection.sourceInterfaceId);
  const targetPort = target.getPort(connection.targetInterfaceId);
  if (!sourcePort || !targetPort) return false;
  return connection.cable.connect(sourcePort, targetPort);
}

type SetFn = (partial: Partial<NetworkState> | ((state: NetworkState) => Partial<NetworkState>)) => void;
type GetFn = () => NetworkState;

function pushHistory(set: SetFn, cmd: HistoryCommand): void {
  set(state => ({
    historyPast: [...state.historyPast, cmd],
    historyFuture: [],
  }));
}

/** Mechanics shared by the public actions and undo/redo — no history
 *  bookkeeping here, callers decide what (if anything) to record. */
function doAddDevice(device: Equipment, set: SetFn): void {
  set(state => {
    const newInstances = new Map(state.deviceInstances);
    newInstances.set(device.getId(), device);
    return { deviceInstances: newInstances };
  });
}

function doRemoveDevice(id: string, get: GetFn, set: SetFn): { device: Equipment; connections: Connection[] } | null {
  const state = get();
  const device = state.deviceInstances.get(id);
  if (!device) return null;

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
  EquipmentRegistry.getInstance().getBus().publish({
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

  return { device, connections: connectionsToRemove };
}

/** Undo of remove (or redo of add): re-registers the SAME instance (its
 *  CLI-configured state was never destroyed, only detached) and
 *  reconnects any cables that were disconnected as a side effect of the
 *  removal. Comes back powered off and with no terminal sessions — see
 *  the HistoryCommand doc comment. */
function doRestoreDevice(device: Equipment, connections: Connection[], get: GetFn, set: SetFn): void {
  EquipmentRegistry.getInstance().register(device);
  set(state => {
    const newInstances = new Map(state.deviceInstances);
    newInstances.set(device.getId(), device);
    return { deviceInstances: newInstances };
  });
  const restored = connections.filter(conn => reconnectCable(conn, get().deviceInstances));
  if (restored.length > 0) {
    set(state => ({ connections: [...state.connections, ...restored] }));
  }
}

function doAddConnection(connection: Connection, set: SetFn): void {
  set(state => ({ connections: [...state.connections, connection] }));
}

function doRemoveConnection(id: string, get: GetFn, set: SetFn): Connection | null {
  const conn = get().connections.find(c => c.id === id);
  if (!conn) return null;
  conn.cable.disconnect();
  set(state => ({
    connections: state.connections.filter(c => c.id !== id),
    selectedConnectionId: state.selectedConnectionId === id ? null : state.selectedConnectionId,
  }));
  return conn;
}

function doRestoreConnection(connection: Connection, get: GetFn, set: SetFn): void {
  if (!reconnectCable(connection, get().deviceInstances)) return;
  set(state => ({ connections: [...state.connections, connection] }));
}

function applyCommand(cmd: HistoryCommand, direction: 'undo' | 'redo', get: GetFn, set: SetFn): void {
  switch (cmd.kind) {
    case 'addDevice':
      if (direction === 'undo') doRemoveDevice(cmd.device.getId(), get, set);
      else doRestoreDevice(cmd.device, [], get, set);
      break;
    case 'removeDevice':
      if (direction === 'undo') doRestoreDevice(cmd.device, cmd.connections, get, set);
      else doRemoveDevice(cmd.device.getId(), get, set);
      break;
    case 'move': {
      const device = get().deviceInstances.get(cmd.deviceId);
      if (device) {
        const pos = direction === 'undo' ? cmd.from : cmd.to;
        device.setPosition(pos.x, pos.y);
        set(state => ({ revision: state.revision + 1 }));
      }
      break;
    }
    case 'addConnection':
      if (direction === 'undo') doRemoveConnection(cmd.connection.id, get, set);
      else doRestoreConnection(cmd.connection, get, set);
      break;
    case 'removeConnection':
      if (direction === 'undo') doRestoreConnection(cmd.connection, get, set);
      else doRemoveConnection(cmd.connection.id, get, set);
      break;
  }
}

/**
 * Bridges autonomous device/link changes (a port going down on a dead-
 * interval timeout, a DHCP lease expiring, ...) into a `revision` bump so
 * the canvas/properties panel pick them up without any zustand action
 * having run first (rapport 09, item #56). Scoped to the handful of
 * topics that actually change a rendered field (`isUp`, `ipAddress`) —
 * NOT `subscribeAll`, which also carries per-frame traffic events and
 * would reintroduce the re-render storm item #52 removed.
 *
 * Each device is watched on ITS OWN bus: the store holds the instances,
 * so it can ask each one, and no machine has to publish onto a channel
 * every other machine can read. Re-checked on every `getDevices()` call
 * because the set of devices changes.
 */
const AUTONOMOUS_REVISION_TOPICS = ['port.link.up', 'port.link.down', 'port.config.ip-changed'] as const;
const watchedDevices = new Map<string, () => void>();

function ensureAutonomousEventBridge(): void {
  const instances = useNetworkStore.getState().deviceInstances;
  for (const [id, stop] of watchedDevices) {
    if (!instances.has(id)) { stop(); watchedDevices.delete(id); }
  }
  const bump = () => useNetworkStore.setState(state => ({ revision: state.revision + 1 }));
  for (const [id, device] of instances) {
    if (watchedDevices.has(id)) continue;
    const bus = device.getBus();
    const unsubs = AUTONOMOUS_REVISION_TOPICS.map(topic => bus.subscribe(topic, bump));
    watchedDevices.set(id, () => unsubs.forEach(u => u()));
  }
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
  historyPast: [],
  historyFuture: [],

  addDevice: (type, x, y) => {
    const device = createDevice(type, x, y);
    doAddDevice(device, set);
    pushHistory(set, { kind: 'addDevice', device });
    return deviceToUI(device);
  },

  removeDevice: (id) => {
    const result = doRemoveDevice(id, get, set);
    if (result) pushHistory(set, { kind: 'removeDevice', device: result.device, connections: result.connections });
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

  commitMove: (id, from, to) => {
    if (from.x === to.x && from.y === to.y) return;
    pushHistory(set, { kind: 'move', deviceId: id, from, to });
  },

  selectDevice: (id) => {
    set({ selectedDeviceId: id, selectedConnectionId: null });
  },

  getDevice: (id) => {
    return get().deviceInstances.get(id);
  },

  getDevices: () => {
    ensureAutonomousEventBridge();
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

    doAddConnection(connection, set);
    pushHistory(set, { kind: 'addConnection', connection });

    return connection;
  },

  removeConnection: (id) => {
    const conn = doRemoveConnection(id, get, set);
    if (conn) pushHistory(set, { kind: 'removeConnection', connection: conn });
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

  undo: () => {
    const state = get();
    const cmd = state.historyPast[state.historyPast.length - 1];
    if (!cmd) return;
    applyCommand(cmd, 'undo', get, set);
    set(state => ({
      historyPast: state.historyPast.slice(0, -1),
      historyFuture: [...state.historyFuture, cmd],
    }));
  },

  redo: () => {
    const state = get();
    const cmd = state.historyFuture[state.historyFuture.length - 1];
    if (!cmd) return;
    applyCommand(cmd, 'redo', get, set);
    set(state => ({
      historyFuture: state.historyFuture.slice(0, -1),
      historyPast: [...state.historyPast, cmd],
    }));
  },

  clearSelection: () => {
    set({ selectedDeviceId: null, selectedConnectionId: null });
  },

  clearAll: () => {
    tearDownCanvas(get(), 'clear');

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
      // A cleared canvas has nothing to undo back to — same "loading a
      // new document resets undo history" rule Import/Open follow.
      historyPast: [],
      historyFuture: [],
    });
  },

  replaceTopology: (deviceInstances, connections) => {
    tearDownCanvas(get(), 'replace');
    Logger.reset();

    set({
      deviceInstances,
      connections,
      selectedDeviceId: null,
      selectedConnectionId: null,
      isConnecting: false,
      connectionSource: null,
      historyPast: [],
      historyFuture: [],
    });
  },
}));

export type { NetworkState };
