/**
 * NetworkSimulator - Mediator Pattern
 *
 * Central coordinator for network communication.
 * Manages device registration, connections, and frame forwarding.
 *
 * Design Pattern: Mediator
 * - Decouples network devices from each other
 * - Centralizes communication logic
 * - Simplifies device implementation
 *
 * Design Pattern: Observer
 * - Emits events for network activities
 * - Allows components to react to network changes
 *
 * @example
 * ```typescript
 * const simulator = new NetworkSimulator();
 *
 * simulator.registerDevice('pc1', new MACAddress('AA:BB:CC:DD:EE:FF'));
 * simulator.registerDevice('pc2', new MACAddress('11:22:33:44:55:66'));
 *
 * simulator.connectDevices('pc1', 'eth0', 'pc2', 'eth0');
 *
 * simulator.on('frameReceived', (event) => {
 *   console.log(`Frame received at ${event.deviceId}`);
 * });
 *
 * simulator.sendFrame('pc1', 'eth0', frame);
 * ```
 */

import { EthernetFrame } from './entities/EthernetFrame';
import { MACAddress } from './value-objects/MACAddress';

/**
 * Network event types
 */
export type NetworkEventType =
  | 'deviceRegistered'
  | 'deviceUnregistered'
  | 'devicesConnected'
  | 'devicesDisconnected'
  | 'frameReceived'
  | 'frameSent'
  | 'frameDropped';

/**
 * Event callback function
 */
export type EventCallback = (data: any) => void;

/**
 * Device information stored in simulator
 */
interface DeviceInfo {
  id: string;
  mac: MACAddress;
  ports: Map<string, PortConnection>;
}

/**
 * Port connection information
 */
interface PortConnection {
  localPort: string;
  remoteDeviceId: string;
  remotePort: string;
}

/**
 * Network statistics
 */
export interface NetworkStatistics {
  totalFrames: number;
  broadcastFrames: number;
  unicastFrames: number;
  droppedFrames: number;
  totalBytes: number;
}

/**
 * NetworkSimulator - Mediator for network communication
 */
export class NetworkSimulator {
  private devices: Map<string, DeviceInfo>;
  private macToDeviceId: Map<string, string>;
  private eventListeners: Map<NetworkEventType, Set<EventCallback>>;
  private statistics: NetworkStatistics;

  constructor() {
    this.devices = new Map();
    this.macToDeviceId = new Map();
    this.eventListeners = new Map();
    this.statistics = {
      totalFrames: 0,
      broadcastFrames: 0,
      unicastFrames: 0,
      droppedFrames: 0,
      totalBytes: 0
    };
  }

  /**
   * Registers a device with the simulator
   *
   * @param deviceId - Unique device identifier
   * @param mac - Device MAC address
   * @throws {Error} If device ID or MAC already registered
   */
  public registerDevice(deviceId: string, mac: MACAddress): void {
    if (this.devices.has(deviceId)) {
      throw new Error(`Device already registered: ${deviceId}`);
    }

    const macStr = mac.toString();
    if (this.macToDeviceId.has(macStr)) {
      throw new Error(`MAC address already in use: ${macStr}`);
    }

    const deviceInfo: DeviceInfo = {
      id: deviceId,
      mac,
      ports: new Map()
    };

    this.devices.set(deviceId, deviceInfo);
    this.macToDeviceId.set(macStr, deviceId);

    this.emit('deviceRegistered', { deviceId, mac });
  }

  /**
   * Unregisters a device from the simulator
   *
   * @param deviceId - Device identifier
   * @throws {Error} If device not found
   */
  public unregisterDevice(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(`Device not found: ${deviceId}`);
    }

    // Disconnect all ports
    for (const [portName] of device.ports) {
      this.disconnectDevices(deviceId, portName);
    }

    this.macToDeviceId.delete(device.mac.toString());
    this.devices.delete(deviceId);

    this.emit('deviceUnregistered', { deviceId });
  }

  /**
   * Checks if a device is registered
   *
   * @param deviceId - Device identifier
   * @returns True if device is registered
   */
  public isDeviceRegistered(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }

  /**
   * Connects two devices via their ports
   *
   * @param deviceId1 - First device ID
   * @param port1 - First device port name
   * @param deviceId2 - Second device ID
   * @param port2 - Second device port name
   * @throws {Error} If devices not found or ports already connected
   */
  public connectDevices(
    deviceId1: string,
    port1: string,
    deviceId2: string,
    port2: string
  ): void {
    const device1 = this.devices.get(deviceId1);
    const device2 = this.devices.get(deviceId2);

    if (!device1) {
      throw new Error(`Device not found: ${deviceId1}`);
    }
    if (!device2) {
      throw new Error(`Device not found: ${deviceId2}`);
    }

    if (device1.ports.has(port1)) {
      throw new Error(`Port already connected: ${deviceId1}:${port1}`);
    }
    if (device2.ports.has(port2)) {
      throw new Error(`Port already connected: ${deviceId2}:${port2}`);
    }

    // Create bidirectional connection
    device1.ports.set(port1, {
      localPort: port1,
      remoteDeviceId: deviceId2,
      remotePort: port2
    });

    device2.ports.set(port2, {
      localPort: port2,
      remoteDeviceId: deviceId1,
      remotePort: port1
    });

    this.emit('devicesConnected', { deviceId1, port1, deviceId2, port2 });
  }

  /**
   * Disconnects a device port
   *
   * @param deviceId - Device identifier
   * @param port - Port name to disconnect
   * @throws {Error} If device or port not found
   */
  public disconnectDevices(deviceId: string, port: string): void {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(`Device not found: ${deviceId}`);
    }

    const connection = device.ports.get(port);
    if (!connection) {
      throw new Error(`Port not connected: ${deviceId}:${port}`);
    }

    // Remove connection from remote device
    const remoteDevice = this.devices.get(connection.remoteDeviceId);
    if (remoteDevice) {
      remoteDevice.ports.delete(connection.remotePort);
    }

    // Remove connection from local device
    device.ports.delete(port);

    this.emit('devicesDisconnected', {
      deviceId1: deviceId,
      port1: port,
      deviceId2: connection.remoteDeviceId,
      port2: connection.remotePort
    });
  }

  /**
   * Checks if two devices are connected
   *
   * @param deviceId1 - First device ID
   * @param deviceId2 - Second device ID
   * @returns True if devices are connected
   */
  public areDevicesConnected(deviceId1: string, deviceId2: string): boolean {
    const device1 = this.devices.get(deviceId1);
    if (!device1) return false;

    for (const connection of device1.ports.values()) {
      if (connection.remoteDeviceId === deviceId2) {
        return true;
      }
    }

    return false;
  }

  /**
   * Sends a frame from a device
   *
   * @param sourceDeviceId - Source device ID
   * @param sourcePort - Source port name
   * @param frame - Ethernet frame to send
   * @throws {Error} If device or port not found
   */
  public sendFrame(sourceDeviceId: string, sourcePort: string, frame: EthernetFrame): void {
    const sourceDevice = this.devices.get(sourceDeviceId);
    if (!sourceDevice) {
      throw new Error(`Device not found: ${sourceDeviceId}`);
    }

    this.emit('frameSent', { deviceId: sourceDeviceId, frame });

    // Update statistics
    this.statistics.totalFrames++;
    this.statistics.totalBytes += frame.getSize();

    if (frame.isBroadcast()) {
      this.statistics.broadcastFrames++;
      this.broadcastFrame(sourceDeviceId, frame);
    } else {
      this.statistics.unicastFrames++;
      this.unicastFrame(sourceDeviceId, sourcePort, frame);
    }
  }

  /**
   * Broadcasts frame to all connected devices except sender
   *
   * @param sourceDeviceId - Source device ID
   * @param frame - Frame to broadcast
   */
  private broadcastFrame(sourceDeviceId: string, frame: EthernetFrame): void {
    const sourceDevice = this.devices.get(sourceDeviceId);
    if (!sourceDevice) return;

    // Send to all devices connected to any port of the source device
    const sentToDevices = new Set<string>();

    for (const connection of sourceDevice.ports.values()) {
      const remoteDeviceId = connection.remoteDeviceId;

      // Avoid sending duplicate frames to the same device
      if (sentToDevices.has(remoteDeviceId)) continue;
      sentToDevices.add(remoteDeviceId);

      this.emit('frameReceived', {
        deviceId: remoteDeviceId,
        frame
      });
    }
  }

  /**
   * Sends unicast frame to specific destination
   *
   * @param sourceDeviceId - Source device ID
   * @param sourcePort - Source port name
   * @param frame - Frame to send
   */
  private unicastFrame(sourceDeviceId: string, sourcePort: string, frame: EthernetFrame): void {
    const destMAC = frame.getDestinationMAC().toString();
    const destDeviceId = this.macToDeviceId.get(destMAC);

    if (!destDeviceId) {
      // Destination not found - drop frame
      this.statistics.droppedFrames++;
      this.emit('frameDropped', {
        deviceId: sourceDeviceId,
        frame,
        reason: 'Destination not found'
      });
      return;
    }

    // Check if devices are connected
    if (!this.areDevicesConnected(sourceDeviceId, destDeviceId)) {
      // Devices not connected - drop frame
      this.statistics.droppedFrames++;
      this.emit('frameDropped', {
        deviceId: sourceDeviceId,
        frame,
        reason: 'Devices not connected'
      });
      return;
    }

    // Deliver frame to destination
    this.emit('frameReceived', {
      deviceId: destDeviceId,
      frame
    });
  }

  /**
   * Registers an event listener
   *
   * @param event - Event type
   * @param callback - Callback function
   */
  public on(event: NetworkEventType, callback: EventCallback): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }

    this.eventListeners.get(event)!.add(callback);
  }

  /**
   * Removes an event listener
   *
   * @param event - Event type
   * @param callback - Callback function
   */
  public off(event: NetworkEventType, callback: EventCallback): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.delete(callback);
    }
  }

  /**
   * Emits an event to all registered listeners
   *
   * @param event - Event type
   * @param data - Event data
   */
  private emit(event: NetworkEventType, data: any): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      for (const callback of listeners) {
        callback(data);
      }
    }
  }

  /**
   * Returns current network statistics
   *
   * @returns Network statistics
   */
  public getStatistics(): Readonly<NetworkStatistics> {
    return { ...this.statistics };
  }

  /**
   * Resets network statistics
   */
  public resetStatistics(): void {
    this.statistics = {
      totalFrames: 0,
      broadcastFrames: 0,
      unicastFrames: 0,
      droppedFrames: 0,
      totalBytes: 0
    };
  }

  /**
   * Returns list of all registered device IDs
   */
  public getRegisteredDevices(): string[] {
    return Array.from(this.devices.keys());
  }

  /**
   * Returns device MAC address
   *
   * @param deviceId - Device identifier
   * @returns MAC address or undefined if device not found
   */
  public getDeviceMAC(deviceId: string): MACAddress | undefined {
    return this.devices.get(deviceId)?.mac;
  }

  /**
   * Clears all devices and connections
   */
  public reset(): void {
    const deviceIds = Array.from(this.devices.keys());
    for (const deviceId of deviceIds) {
      this.unregisterDevice(deviceId);
    }

    this.resetStatistics();
  }
}
