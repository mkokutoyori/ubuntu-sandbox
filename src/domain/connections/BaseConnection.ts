/**
 * BaseConnection - Abstract base class for all network connections
 *
 * Represents a physical or logical link between two network devices.
 * Handles frame forwarding, bandwidth simulation, and link status.
 *
 * Design Pattern: Template Method
 * - Defines common connection structure
 * - Subclasses implement specific media behavior
 *
 * @example
 * ```typescript
 * const conn = new EthernetConnection({
 *   id: 'conn-1',
 *   sourceDeviceId: 'pc1',
 *   sourceInterfaceId: 'eth0',
 *   targetDeviceId: 'sw1',
 *   targetInterfaceId: 'eth0'
 * });
 *
 * conn.transmitFrame('pc1', frame); // Delivers frame to sw1
 * ```
 */

import { EthernetFrame } from '../network/entities/EthernetFrame';
import { ConnectionType } from '../devices/types';

/**
 * Connection status
 */
export type ConnectionStatus = 'up' | 'down';

/**
 * Connection endpoint
 */
export interface ConnectionEndpoint {
  deviceId: string;
  interfaceId: string;
}

/**
 * Connection statistics
 */
export interface ConnectionStatistics {
  txFrames: number;
  rxFrames: number;
  txBytes: number;
  rxBytes: number;
  droppedFrames: number;
  errors: number;
}

/**
 * Frame delivery callback - called when a frame reaches the other end
 */
export type FrameDeliveryCallback = (
  targetDeviceId: string,
  targetInterfaceId: string,
  frame: EthernetFrame
) => void;

/**
 * Configuration for creating a connection
 */
export interface ConnectionConfig {
  id: string;
  sourceDeviceId: string;
  sourceInterfaceId: string;
  targetDeviceId: string;
  targetInterfaceId: string;
}

/**
 * BaseConnection - Abstract base class for network connections
 */
export abstract class BaseConnection {
  protected readonly id: string;
  protected readonly type: ConnectionType;
  protected readonly source: ConnectionEndpoint;
  protected readonly target: ConnectionEndpoint;
  protected status: ConnectionStatus;
  protected statistics: ConnectionStatistics;
  protected deliveryCallback?: FrameDeliveryCallback;

  constructor(config: ConnectionConfig, type: ConnectionType) {
    this.id = config.id;
    this.type = type;
    this.source = {
      deviceId: config.sourceDeviceId,
      interfaceId: config.sourceInterfaceId
    };
    this.target = {
      deviceId: config.targetDeviceId,
      interfaceId: config.targetInterfaceId
    };
    this.status = 'up';
    this.statistics = {
      txFrames: 0,
      rxFrames: 0,
      txBytes: 0,
      rxBytes: 0,
      droppedFrames: 0,
      errors: 0
    };
  }

  /**
   * Returns connection ID
   */
  public getId(): string {
    return this.id;
  }

  /**
   * Returns connection type
   */
  public getType(): ConnectionType {
    return this.type;
  }

  /**
   * Returns source endpoint
   */
  public getSource(): Readonly<ConnectionEndpoint> {
    return { ...this.source };
  }

  /**
   * Returns target endpoint
   */
  public getTarget(): Readonly<ConnectionEndpoint> {
    return { ...this.target };
  }

  /**
   * Returns connection status
   */
  public getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * Checks if connection is active
   */
  public isActive(): boolean {
    return this.status === 'up';
  }

  /**
   * Brings connection up
   */
  public up(): void {
    this.status = 'up';
  }

  /**
   * Brings connection down
   */
  public down(): void {
    this.status = 'down';
  }

  /**
   * Returns connection statistics
   */
  public getStatistics(): Readonly<ConnectionStatistics> {
    return { ...this.statistics };
  }

  /**
   * Resets connection statistics
   */
  public resetStatistics(): void {
    this.statistics = {
      txFrames: 0,
      rxFrames: 0,
      txBytes: 0,
      rxBytes: 0,
      droppedFrames: 0,
      errors: 0
    };
  }

  /**
   * Registers callback for frame delivery
   * Called when a frame reaches the other end of the connection
   */
  public onFrameDelivery(callback: FrameDeliveryCallback): void {
    this.deliveryCallback = callback;
  }

  /**
   * Transmits a frame from one device to the other through this connection
   *
   * @param fromDeviceId - Device ID of the sender
   * @param frame - Ethernet frame to transmit
   * @returns True if frame was delivered successfully
   */
  public transmitFrame(fromDeviceId: string, frame: EthernetFrame): boolean {
    if (!this.isActive()) {
      this.statistics.droppedFrames++;
      return false;
    }

    // Determine destination endpoint
    let targetDeviceId: string;
    let targetInterfaceId: string;

    if (fromDeviceId === this.source.deviceId) {
      targetDeviceId = this.target.deviceId;
      targetInterfaceId = this.target.interfaceId;
    } else if (fromDeviceId === this.target.deviceId) {
      targetDeviceId = this.source.deviceId;
      targetInterfaceId = this.source.interfaceId;
    } else {
      this.statistics.errors++;
      return false;
    }

    // Check frame against connection constraints
    if (!this.validateFrame(frame)) {
      this.statistics.droppedFrames++;
      return false;
    }

    // Update statistics
    this.statistics.txFrames++;
    this.statistics.txBytes += frame.getSize();

    // Apply media-specific processing
    this.processFrame(frame);

    // Deliver frame
    this.statistics.rxFrames++;
    this.statistics.rxBytes += frame.getSize();

    if (this.deliveryCallback) {
      this.deliveryCallback(targetDeviceId, targetInterfaceId, frame);
    }

    return true;
  }

  /**
   * Returns the other endpoint's device ID given one device ID
   */
  public getRemoteDeviceId(localDeviceId: string): string | null {
    if (localDeviceId === this.source.deviceId) {
      return this.target.deviceId;
    }
    if (localDeviceId === this.target.deviceId) {
      return this.source.deviceId;
    }
    return null;
  }

  /**
   * Returns the remote interface ID given a local device ID
   */
  public getRemoteInterfaceId(localDeviceId: string): string | null {
    if (localDeviceId === this.source.deviceId) {
      return this.target.interfaceId;
    }
    if (localDeviceId === this.target.deviceId) {
      return this.source.interfaceId;
    }
    return null;
  }

  /**
   * Returns the local interface ID for a given device ID
   */
  public getLocalInterfaceId(deviceId: string): string | null {
    if (deviceId === this.source.deviceId) {
      return this.source.interfaceId;
    }
    if (deviceId === this.target.deviceId) {
      return this.target.interfaceId;
    }
    return null;
  }

  /**
   * Checks if a device is part of this connection
   */
  public involvesDevice(deviceId: string): boolean {
    return this.source.deviceId === deviceId || this.target.deviceId === deviceId;
  }

  /**
   * Returns bandwidth in Mbps
   */
  public abstract getBandwidth(): number;

  /**
   * Returns latency in milliseconds
   */
  public abstract getLatency(): number;

  /**
   * Validates frame against connection constraints (e.g., MTU)
   */
  protected abstract validateFrame(frame: EthernetFrame): boolean;

  /**
   * Applies media-specific processing to the frame
   */
  protected abstract processFrame(frame: EthernetFrame): void;

  /**
   * Serializes connection to plain object (for store compatibility)
   */
  public toJSON() {
    return {
      id: this.id,
      type: this.type,
      sourceDeviceId: this.source.deviceId,
      sourceInterfaceId: this.source.interfaceId,
      targetDeviceId: this.target.deviceId,
      targetInterfaceId: this.target.interfaceId,
      isActive: this.isActive()
    };
  }
}
