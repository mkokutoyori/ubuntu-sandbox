/**
 * EthernetConnection - Active connection that transfers frames between devices
 *
 * Implements the Connection interface but adds active frame transfer logic.
 * This class is responsible for:
 * - Wiring up device interfaces for frame transmission
 * - Transferring frames bidirectionally between connected devices
 * - Emitting events for visualization
 * - Supporting activation/deactivation of the connection
 *
 * Design Pattern: Observer + Mediator
 * - Observer: Listens to interface transmit events
 * - Mediator: Coordinates frame delivery between devices
 *
 * @example
 * ```typescript
 * const connection = new EthernetConnection({
 *   id: 'conn-1',
 *   type: 'ethernet',
 *   sourceDeviceId: 'pc1',
 *   sourceInterfaceId: 'eth0',
 *   targetDeviceId: 'sw1',
 *   targetInterfaceId: 'eth0',
 *   isActive: true
 * }, pc1, sw1);
 *
 * connection.wireUp();
 * // Now frames transmitted from pc1.eth0 will be delivered to sw1.eth0 and vice versa
 * ```
 */

import { Connection, ConnectionType } from '@/domain/devices/types';
import { EthernetFrame } from './entities/EthernetFrame';

/**
 * Device interface for connection wiring
 * Supports both PC (with NetworkInterface) and Switch devices
 */
interface ConnectableDevice {
  getId?(): string;
  getInterface?(name: string): { 
    onTransmit(callback: (frame: EthernetFrame) => void): void;
    clearTransmitCallbacks(): void;
    receive(frame: EthernetFrame): void;
    isUp(): boolean;
  } | undefined;
  getInterfaces?(): Array<{
    getName(): string;
    onTransmit(callback: (frame: EthernetFrame) => void): void;
    clearTransmitCallbacks(): void;
    receive(frame: EthernetFrame): void;
    isUp(): boolean;
  }>;
  // Switch-specific methods
  receiveFrame?(port: string, frame: EthernetFrame): void;
  onFrameForward?(callback: (port: string, frame: EthernetFrame) => void): void;
  hasPort?(port: string): boolean;
}

/**
 * Event emitted when a frame is transferred
 */
export interface ConnectionEvent {
  type: 'frame_transferred';
  connectionId: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  frame: EthernetFrame;
  timestamp: number;
}

/**
 * Event listener callback type
 */
export type ConnectionEventListener = (event: ConnectionEvent) => void;

/**
 * Configuration for creating an EthernetConnection
 */
export interface EthernetConnectionConfig {
  id: string;
  type: ConnectionType;
  sourceDeviceId: string;
  sourceInterfaceId: string;
  targetDeviceId: string;
  targetInterfaceId: string;
  isActive: boolean;
}

/**
 * EthernetConnection - Manages bidirectional frame transfer between two devices
 */
export class EthernetConnection implements Connection {
  // Connection interface properties
  public readonly id: string;
  public readonly type: ConnectionType;
  public readonly sourceDeviceId: string;
  public readonly sourceInterfaceId: string;
  public readonly targetDeviceId: string;
  public readonly targetInterfaceId: string;
  public isActive: boolean;

  // Internal state
  private readonly sourceDevice: ConnectableDevice;
  private readonly targetDevice: ConnectableDevice;
  private eventListeners: Set<ConnectionEventListener> = new Set();
  private isWired: boolean = false;
  
  // Store callbacks for cleanup
  private sourceTransmitCallback?: (frame: EthernetFrame) => void;
  private targetTransmitCallback?: (frame: EthernetFrame) => void;
  private switchForwardCallback?: (port: string, frame: EthernetFrame) => void;

  constructor(config: EthernetConnectionConfig, sourceDevice: ConnectableDevice, targetDevice: ConnectableDevice) {
    this.id = config.id;
    this.type = config.type;
    this.sourceDeviceId = config.sourceDeviceId;
    this.sourceInterfaceId = config.sourceInterfaceId;
    this.targetDeviceId = config.targetDeviceId;
    this.targetInterfaceId = config.targetInterfaceId;
    this.isActive = config.isActive;

    this.sourceDevice = sourceDevice;
    this.targetDevice = targetDevice;
  }

  /**
   * Wire up the connection to transfer frames between devices
   * Sets up callbacks on device interfaces
   */
  public wireUp(): void {
    if (this.isWired) return;

    // Wire source device
    this.wireUpSourceDevice();

    // Wire target device  
    this.wireUpTargetDevice();

    this.isWired = true;
  }

  /**
   * Wire up the source device for frame transmission
   */
  private wireUpSourceDevice(): void {
    // Check if source is a Switch
    if (this.isSwitch(this.sourceDevice)) {
      this.wireUpSwitchAsSource();
      return;
    }

    // Source is a PC/Router with NetworkInterface
    const sourceInterface = this.sourceDevice.getInterface?.(this.sourceInterfaceId);
    if (!sourceInterface) return;

    this.sourceTransmitCallback = (frame: EthernetFrame) => {
      if (!this.isActive) return;
      this.deliverToTarget(frame);
      this.emitEvent('frame_transferred', this.sourceDeviceId, this.targetDeviceId, frame);
    };

    sourceInterface.onTransmit(this.sourceTransmitCallback);
  }

  /**
   * Wire up the target device for frame transmission
   */
  private wireUpTargetDevice(): void {
    // Check if target is a Switch
    if (this.isSwitch(this.targetDevice)) {
      this.wireUpSwitchAsTarget();
      return;
    }

    // Target is a PC/Router with NetworkInterface
    const targetInterface = this.targetDevice.getInterface?.(this.targetInterfaceId);
    if (!targetInterface) return;

    this.targetTransmitCallback = (frame: EthernetFrame) => {
      if (!this.isActive) return;
      this.deliverToSource(frame);
      this.emitEvent('frame_transferred', this.targetDeviceId, this.sourceDeviceId, frame);
    };

    targetInterface.onTransmit(this.targetTransmitCallback);
  }

  /**
   * Wire up a Switch as the source device
   */
  private wireUpSwitchAsSource(): void {
    // Switch uses onFrameForward callback
    this.switchForwardCallback = (port: string, frame: EthernetFrame) => {
      if (!this.isActive) return;
      if (port !== this.sourceInterfaceId) return; // Only forward from our port
      
      this.deliverToTarget(frame);
      this.emitEvent('frame_transferred', this.sourceDeviceId, this.targetDeviceId, frame);
    };

    this.sourceDevice.onFrameForward?.(this.switchForwardCallback);
  }

  /**
   * Wire up a Switch as the target device
   */
  private wireUpSwitchAsTarget(): void {
    // Switch uses onFrameForward callback
    const callback = (port: string, frame: EthernetFrame) => {
      if (!this.isActive) return;
      if (port !== this.targetInterfaceId) return; // Only forward from our port
      
      this.deliverToSource(frame);
      this.emitEvent('frame_transferred', this.targetDeviceId, this.sourceDeviceId, frame);
    };

    this.targetDevice.onFrameForward?.(callback);
  }

  /**
   * Deliver frame to target device
   */
  private deliverToTarget(frame: EthernetFrame): void {
    // Check if target is a Switch
    if (this.isSwitch(this.targetDevice)) {
      this.targetDevice.receiveFrame?.(this.targetInterfaceId, frame);
      return;
    }

    // Target is a PC/Router with NetworkInterface
    const targetInterface = this.targetDevice.getInterface?.(this.targetInterfaceId);
    if (targetInterface) {
      targetInterface.receive(frame);
    }
  }

  /**
   * Deliver frame to source device
   */
  private deliverToSource(frame: EthernetFrame): void {
    // Check if source is a Switch
    if (this.isSwitch(this.sourceDevice)) {
      this.sourceDevice.receiveFrame?.(this.sourceInterfaceId, frame);
      return;
    }

    // Source is a PC/Router with NetworkInterface
    const sourceInterface = this.sourceDevice.getInterface?.(this.sourceInterfaceId);
    if (sourceInterface) {
      sourceInterface.receive(frame);
    }
  }

  /**
   * Check if device is a Switch (has receiveFrame and onFrameForward methods)
   */
  private isSwitch(device: ConnectableDevice): boolean {
    return typeof device.receiveFrame === 'function' && 
           typeof device.onFrameForward === 'function';
  }

  /**
   * Unwire the connection, removing all callbacks
   */
  public unwire(): void {
    if (!this.isWired) return;

    // Clear callbacks on source device
    if (!this.isSwitch(this.sourceDevice)) {
      const sourceInterface = this.sourceDevice.getInterface?.(this.sourceInterfaceId);
      if (sourceInterface) {
        sourceInterface.clearTransmitCallbacks();
      }
    }

    // Clear callbacks on target device
    if (!this.isSwitch(this.targetDevice)) {
      const targetInterface = this.targetDevice.getInterface?.(this.targetInterfaceId);
      if (targetInterface) {
        targetInterface.clearTransmitCallbacks();
      }
    }

    // Clear stored callbacks
    this.sourceTransmitCallback = undefined;
    this.targetTransmitCallback = undefined;
    this.switchForwardCallback = undefined;

    this.isWired = false;
  }

  /**
   * Activate the connection (resume frame transfer)
   */
  public activate(): void {
    this.isActive = true;
  }

  /**
   * Deactivate the connection (stop frame transfer)
   */
  public deactivate(): void {
    this.isActive = false;
  }

  /**
   * Add event listener for connection events
   */
  public addEventListener(listener: ConnectionEventListener): void {
    this.eventListeners.add(listener);
  }

  /**
   * Remove event listener
   */
  public removeEventListener(listener: ConnectionEventListener): void {
    this.eventListeners.delete(listener);
  }

  /**
   * Emit a connection event to all listeners
   */
  private emitEvent(
    type: 'frame_transferred',
    sourceDeviceId: string,
    targetDeviceId: string,
    frame: EthernetFrame
  ): void {
    const event: ConnectionEvent = {
      type,
      connectionId: this.id,
      sourceDeviceId,
      targetDeviceId,
      frame,
      timestamp: Date.now()
    };

    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  /**
   * Export connection as plain Connection object (for serialization)
   */
  public toJSON(): Connection {
    return {
      id: this.id,
      type: this.type,
      sourceDeviceId: this.sourceDeviceId,
      sourceInterfaceId: this.sourceInterfaceId,
      targetDeviceId: this.targetDeviceId,
      targetInterfaceId: this.targetInterfaceId,
      isActive: this.isActive
    };
  }
}
