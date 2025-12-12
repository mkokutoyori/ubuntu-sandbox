/**
 * Network Store - State management for network topology
 */

import { create } from 'zustand';
import { 
  NetworkDevice, 
  Connection, 
  DeviceType, 
  ConnectionType,
  generateId,
  getDefaultInterfaces 
} from './types';

interface NetworkState {
  devices: NetworkDevice[];
  connections: Connection[];
  selectedDeviceId: string | null;
  selectedConnectionId: string | null;
  isConnecting: boolean;
  connectionSource: { deviceId: string; interfaceId: string } | null;
  zoom: number;
  panX: number;
  panY: number;
  
  // Actions
  addDevice: (type: DeviceType, x: number, y: number) => NetworkDevice;
  removeDevice: (id: string) => void;
  updateDevice: (id: string, updates: Partial<NetworkDevice>) => void;
  moveDevice: (id: string, x: number, y: number) => void;
  selectDevice: (id: string | null) => void;
  
  addConnection: (
    sourceDeviceId: string,
    sourceInterfaceId: string,
    targetDeviceId: string,
    targetInterfaceId: string,
    type?: ConnectionType
  ) => Connection | null;
  removeConnection: (id: string) => void;
  selectConnection: (id: string | null) => void;
  
  startConnecting: (deviceId: string, interfaceId: string) => void;
  finishConnecting: (deviceId: string, interfaceId: string) => void;
  cancelConnecting: () => void;
  
  setZoom: (zoom: number) => void;
  setPan: (x: number, y: number) => void;
  
  clearSelection: () => void;
  clearAll: () => void;
}

let deviceCounters: Record<DeviceType, number> = {} as any;

function getDeviceName(type: DeviceType): string {
  if (!deviceCounters[type]) deviceCounters[type] = 0;
  deviceCounters[type]++;
  
  const names: Record<DeviceType, string> = {
    'linux-pc': 'Linux-PC',
    'windows-pc': 'Windows-PC',
    'mac-pc': 'Mac',
    'linux-server': 'Linux-Server',
    'windows-server': 'Win-Server',
    'db-mysql': 'MySQL',
    'db-postgres': 'PostgreSQL',
    'db-oracle': 'Oracle',
    'db-sqlserver': 'SQLServer',
    'router-cisco': 'Router-Cisco',
    'router-huawei': 'Router-Huawei',
    'switch-cisco': 'Switch-Cisco',
    'switch-huawei': 'Switch-Huawei',
    'firewall-fortinet': 'FortiGate',
    'firewall-cisco': 'Cisco-ASA',
    'firewall-paloalto': 'PaloAlto',
    'access-point': 'AP',
    'cloud': 'Cloud'
  };
  
  return `${names[type]}-${deviceCounters[type]}`;
}

export const useNetworkStore = create<NetworkState>((set, get) => ({
  devices: [],
  connections: [],
  selectedDeviceId: null,
  selectedConnectionId: null,
  isConnecting: false,
  connectionSource: null,
  zoom: 1,
  panX: 0,
  panY: 0,

  addDevice: (type, x, y) => {
    const device: NetworkDevice = {
      id: generateId(),
      type,
      name: getDeviceName(type),
      x,
      y,
      interfaces: getDefaultInterfaces(type),
      isPoweredOn: true
    };
    
    set(state => ({
      devices: [...state.devices, device]
    }));
    
    return device;
  },

  removeDevice: (id) => {
    set(state => ({
      devices: state.devices.filter(d => d.id !== id),
      connections: state.connections.filter(
        c => c.sourceDeviceId !== id && c.targetDeviceId !== id
      ),
      selectedDeviceId: state.selectedDeviceId === id ? null : state.selectedDeviceId
    }));
  },

  updateDevice: (id, updates) => {
    set(state => ({
      devices: state.devices.map(d => 
        d.id === id ? { ...d, ...updates } : d
      )
    }));
  },

  moveDevice: (id, x, y) => {
    set(state => ({
      devices: state.devices.map(d => 
        d.id === id ? { ...d, x, y } : d
      )
    }));
  },

  selectDevice: (id) => {
    set({ selectedDeviceId: id, selectedConnectionId: null });
  },

  addConnection: (sourceDeviceId, sourceInterfaceId, targetDeviceId, targetInterfaceId, type = 'ethernet') => {
    const state = get();
    
    // Check if connection already exists
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
    deviceCounters = {} as any;
    set({
      devices: [],
      connections: [],
      selectedDeviceId: null,
      selectedConnectionId: null,
      isConnecting: false,
      connectionSource: null
    });
  }
}));
