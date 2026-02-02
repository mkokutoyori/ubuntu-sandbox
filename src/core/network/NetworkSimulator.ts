/**
 * NetworkSimulator - Core network simulation engine
 *
 * Manages frame forwarding between connected devices.
 * Implements the Mediator pattern to coordinate device communication.
 *
 * Key responsibilities:
 * - Wire up device interfaces for frame transmission
 * - Forward frames between connected devices using concrete connection instances
 * - Support switch MAC learning and forwarding
 * - Support hub frame repetition
 * - Emit events for UI visualization
 */

import { BaseDevice, Connection, BaseConnection } from '@/domain/devices';
import { EthernetFrame } from '@/domain/network/entities/EthernetFrame';

export interface NetworkFrame {
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
  frame?: NetworkFrame;
}

export type NetworkEventListener = (event: NetworkEvent) => void;

/**
 * Connection info for finding linked devices
 */
interface ConnectionLink {
  localInterfaceId: string;
  remoteDeviceId: string;
  remoteInterfaceId: string;
  connectionInstance?: BaseConnection;
}

class NetworkSimulatorSingleton {
  private devices: Map<string, BaseDevice> = new Map();
  private connections: Connection[] = [];
  private listeners: Set<NetworkEventListener> = new Set();
  private initialized = false;

  // Map of deviceId -> array of connection links
  private deviceConnections: Map<string, ConnectionLink[]> = new Map();

  // Map of connection instances by ID for fast access
  private connectionInstances: Map<string, BaseConnection> = new Map();

  /**
   * Initialize the simulator with devices and connections
   * Wires up device interfaces for frame transmission
   */
  initialize(devices: Map<string, BaseDevice>, connections: Connection[]): void {
    this.devices = devices;
    this.connections = connections;
    this.initialized = true;

    // Build connection index for fast lookups
    this.buildConnectionIndex();

    // Wire up connection instances for frame delivery
    this.wireUpConnectionInstances();

    // Wire up all devices for frame forwarding
    this.wireUpDevices();
  }

  /**
   * Build index of device connections for fast lookups
   */
  private buildConnectionIndex(): void {
    this.deviceConnections.clear();
    this.connectionInstances.clear();

    for (const conn of this.connections) {
      const instance = conn.instance;

      // Store connection instance if available
      if (instance) {
        this.connectionInstances.set(conn.id, instance);
      }

      // Add forward link: source -> target
      if (!this.deviceConnections.has(conn.sourceDeviceId)) {
        this.deviceConnections.set(conn.sourceDeviceId, []);
      }
      this.deviceConnections.get(conn.sourceDeviceId)!.push({
        localInterfaceId: conn.sourceInterfaceId,
        remoteDeviceId: conn.targetDeviceId,
        remoteInterfaceId: conn.targetInterfaceId,
        connectionInstance: instance
      });

      // Add reverse link: target -> source
      if (!this.deviceConnections.has(conn.targetDeviceId)) {
        this.deviceConnections.set(conn.targetDeviceId, []);
      }
      this.deviceConnections.get(conn.targetDeviceId)!.push({
        localInterfaceId: conn.targetInterfaceId,
        remoteDeviceId: conn.sourceDeviceId,
        remoteInterfaceId: conn.sourceInterfaceId,
        connectionInstance: instance
      });
    }
  }

  /**
   * Wire up connection instances to deliver frames to target devices
   */
  private wireUpConnectionInstances(): void {
    for (const [, instance] of this.connectionInstances) {
      instance.onFrameDelivery((targetDeviceId, targetInterfaceId, frame) => {
        const targetDevice = this.devices.get(targetDeviceId);
        if (!targetDevice) return;

        this.deliverFrame(targetDevice, targetInterfaceId, frame);
      });
    }
  }

  /**
   * Wire up all devices to forward frames through the simulator
   */
  private wireUpDevices(): void {
    for (const [deviceId, device] of this.devices) {
      this.wireUpDevice(deviceId, device);
    }
  }

  /**
   * Wire up a single device for frame forwarding
   */
  private wireUpDevice(deviceId: string, device: BaseDevice): void {
    // Check if device has interfaces (PC, Router)
    if ('getInterfaces' in device && typeof (device as any).getInterfaces === 'function') {
      const interfaces = (device as any).getInterfaces();
      for (const iface of interfaces) {
        this.wireUpInterface(deviceId, iface);
      }
    }

    // Check if device is a Switch or Hub with frame forwarding
    // Both Switch and Hub use onFrameForward callback
    if ('onFrameForward' in device && typeof (device as any).onFrameForward === 'function') {
      const deviceType = device.getType();
      if (deviceType === 'hub') {
        (device as any).onFrameForward((port: string, frame: EthernetFrame) => {
          this.handleHubRepeat(deviceId, port, frame);
        });
      } else {
        // Switch and other L2 devices
        (device as any).onFrameForward((port: string, frame: EthernetFrame) => {
          this.handleSwitchForward(deviceId, port, frame);
        });
      }
    }
  }

  /**
   * Wire up a network interface for frame transmission
   */
  private wireUpInterface(deviceId: string, iface: any): void {
    if (!iface || typeof iface.onTransmit !== 'function') return;

    const interfaceName = iface.getName();

    iface.onTransmit((frame: EthernetFrame) => {
      this.handleFrameTransmit(deviceId, interfaceName, frame);
    });
  }

  /**
   * Handle frame transmitted from a device interface
   * Uses the concrete connection instance to forward the frame
   */
  private handleFrameTransmit(sourceDeviceId: string, sourceInterfaceId: string, frame: EthernetFrame): void {
    // Find where this frame should go
    const links = this.deviceConnections.get(sourceDeviceId) || [];
    const link = links.find(l => l.localInterfaceId === sourceInterfaceId);

    if (!link) {
      // No connection on this interface
      return;
    }

    const targetDevice = this.devices.get(link.remoteDeviceId);
    if (!targetDevice) return;

    // Emit frame_sent event for visualization
    this.emitEvent({
      type: 'frame_sent',
      timestamp: Date.now(),
      sourceDeviceId,
      destinationDeviceId: link.remoteDeviceId,
      frame: this.convertFrameForEvent(frame)
    });

    // Use connection instance if available for realistic forwarding
    if (link.connectionInstance) {
      link.connectionInstance.transmitFrame(sourceDeviceId, frame);
    } else {
      // Fallback: direct delivery
      this.deliverFrame(targetDevice, link.remoteInterfaceId, frame);
    }
  }

  /**
   * Handle switch forwarding a frame
   */
  private handleSwitchForward(switchId: string, outPort: string, frame: EthernetFrame): void {
    const links = this.deviceConnections.get(switchId) || [];
    const link = links.find(l => l.localInterfaceId === outPort);

    if (!link) return;

    const targetDevice = this.devices.get(link.remoteDeviceId);
    if (!targetDevice) return;

    // Emit event
    this.emitEvent({
      type: 'frame_sent',
      timestamp: Date.now(),
      sourceDeviceId: switchId,
      destinationDeviceId: link.remoteDeviceId,
      frame: this.convertFrameForEvent(frame)
    });

    // Use connection instance if available
    if (link.connectionInstance) {
      link.connectionInstance.transmitFrame(switchId, frame);
    } else {
      this.deliverFrame(targetDevice, link.remoteInterfaceId, frame);
    }
  }

  /**
   * Handle hub repeating a frame to all ports except source
   */
  private handleHubRepeat(hubId: string, outPort: string, frame: EthernetFrame): void {
    const links = this.deviceConnections.get(hubId) || [];
    const link = links.find(l => l.localInterfaceId === outPort);

    if (!link) return;

    const targetDevice = this.devices.get(link.remoteDeviceId);
    if (!targetDevice) return;

    // Emit event
    this.emitEvent({
      type: 'frame_sent',
      timestamp: Date.now(),
      sourceDeviceId: hubId,
      destinationDeviceId: link.remoteDeviceId,
      frame: this.convertFrameForEvent(frame)
    });

    // Use connection instance if available
    if (link.connectionInstance) {
      link.connectionInstance.transmitFrame(hubId, frame);
    } else {
      this.deliverFrame(targetDevice, link.remoteInterfaceId, frame);
    }
  }

  /**
   * Deliver a frame to a device
   */
  private deliverFrame(device: BaseDevice, interfaceId: string, frame: EthernetFrame): void {
    // If device has receiveFrame (Switch, Hub, or PC with that method)
    if ('receiveFrame' in device && typeof (device as any).receiveFrame === 'function') {
      (device as any).receiveFrame(interfaceId, frame);
      return;
    }

    // For PC/Router with interfaces
    if ('getInterface' in device && typeof (device as any).getInterface === 'function') {
      const iface = (device as any).getInterface(interfaceId);
      if (iface && typeof iface.receive === 'function') {
        iface.receive(frame);
      }
    }
  }

  /**
   * Convert an EthernetFrame to event format
   */
  private convertFrameForEvent(frame: EthernetFrame): NetworkFrame {
    return {
      sourceMAC: frame.getSourceMAC().toString(),
      destinationMAC: frame.getDestinationMAC().toString(),
      etherType: frame.getEtherType(),
      payload: frame.getPayload()
    };
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

  /**
   * Get a connection instance by ID
   */
  getConnectionInstance(connectionId: string): BaseConnection | undefined {
    return this.connectionInstances.get(connectionId);
  }

  /**
   * Get all connection instances
   */
  getConnectionInstances(): Map<string, BaseConnection> {
    return new Map(this.connectionInstances);
  }

  /**
   * Get MAC table for a switch device
   */
  getMACTable(deviceId: string): Map<string, string> {
    const device = this.devices.get(deviceId);
    if (!device) return new Map();

    // Check if device has getMACTable method (Switch)
    if ('getMACTable' in device && typeof (device as any).getMACTable === 'function') {
      const macTableService = (device as any).getMACTable();
      // MACTableService returns entries, convert to Map
      if (macTableService && typeof macTableService.getEntries === 'function') {
        const entries = macTableService.getEntries();
        const result = new Map<string, string>();
        for (const entry of entries) {
          result.set(entry.mac.toString(), entry.port);
        }
        return result;
      }
    }

    return new Map();
  }

  /**
   * Clear MAC table for a switch device
   */
  clearMACTable(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (!device) return;

    if ('getMACTable' in device && typeof (device as any).getMACTable === 'function') {
      const macTableService = (device as any).getMACTable();
      if (macTableService && typeof macTableService.clear === 'function') {
        macTableService.clear();
      }
    }
  }

  getConnectionInfo(): any {
    return {
      devices: this.devices.size,
      connections: this.connections.length,
      connectionInstances: this.connectionInstances.size,
      deviceConnections: Object.fromEntries(this.deviceConnections)
    };
  }

  private emitEvent(event: NetworkEvent): void {
    this.listeners.forEach(listener => listener(event));
  }

  /**
   * Reset the simulator
   */
  reset(): void {
    this.devices.clear();
    this.connections = [];
    this.deviceConnections.clear();
    this.connectionInstances.clear();
    this.initialized = false;
  }
}

export const NetworkSimulator = new NetworkSimulatorSingleton();
