/**
 * STUB FILE - NetworkSimulator for UI compatibility
 * This file contains minimal implementation to keep the UI functional
 * Real implementation will be rebuilt with TDD
 */

import { BaseDevice, Connection } from '@/domain/devices';

export interface EthernetFrame {
  sourceMAC: string;
  destinationMAC: string;
  etherType: number;
  payload: any;
}

export interface NetworkEvent {
  type: 'frame_sent' | 'frame_received' | 'device_connected' | 'device_disconnected';
  timestamp: number;
  sourceDeviceId: string;
  destinationDeviceId?: string;
  frame?: EthernetFrame;
}

export type NetworkEventListener = (event: NetworkEvent) => void;

class NetworkSimulatorSingleton {
  private devices: Map<string, BaseDevice> = new Map();
  private connections: Connection[] = [];
  private listeners: Set<NetworkEventListener> = new Set();
  private initialized = false;

  initialize(devices: Map<string, BaseDevice>, connections: Connection[]): void {
    this.devices = devices;
    this.connections = connections;
    this.initialized = true;
  }

  isReady(): boolean {
    return this.initialized;
  }

  addEventListener(listener: NetworkEventListener): void {
    this.listeners.add(listener);
  }

  removeEventListener(listener: NetworkEventListener): void {
    this.listeners.delete(listener);
  }

  getMACTable(deviceId: string): Map<string, string> {
    // STUB: Returns empty MAC table
    return new Map();
  }

  clearMACTable(deviceId: string): void {
    // STUB: No-op
  }

  getConnectionInfo(): any {
    return {
      devices: this.devices.size,
      connections: this.connections.length
    };
  }

  // STUB: Method to emit events (for future implementation)
  private emitEvent(event: NetworkEvent): void {
    this.listeners.forEach(listener => listener(event));
  }
}

export const NetworkSimulator = new NetworkSimulatorSingleton();
