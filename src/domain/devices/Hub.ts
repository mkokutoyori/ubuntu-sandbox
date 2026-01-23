/**
 * Hub (Layer 1) Device
 *
 * Represents an Ethernet hub (also called repeater) with:
 * - Multiple ports
 * - Simple frame repetition to all ports (except ingress)
 * - NO MAC learning (unlike switches)
 * - NO frame filtering
 * - Port enable/disable
 *
 * Design Pattern: Simple forwarding
 * - No service composition (no MAC table, no ARP)
 * - Pure Layer 1 behavior: receive and repeat
 *
 * @example
 * ```typescript
 * const hub = new Hub('hub1', 'Office Hub', 8); // 8-port hub
 *
 * hub.powerOn();
 *
 * hub.onFrameForward((port, frame) => {
 *   // Forward frame to specified port
 *   connectedDevice.receiveFrame(port, frame);
 * });
 *
 * hub.receiveFrame('eth0', frame);
 * // Frame is repeated to eth1, eth2, eth3, eth4, eth5, eth6, eth7
 * ```
 */

import { BaseDevice } from './BaseDevice';
import { EthernetFrame } from '../network/entities/EthernetFrame';

/**
 * Frame forward callback type
 */
type FrameForwardCallback = (port: string, frame: EthernetFrame) => void;

/**
 * Port configuration
 */
interface PortConfig {
  enabled: boolean;
}

/**
 * Hub statistics
 */
export interface HubStatistics {
  totalFrames: number;
}

/**
 * Hub - Layer 1 Ethernet hub (repeater)
 */
export class Hub extends BaseDevice {
  private readonly portCount: number;
  private readonly portConfigs: Map<string, PortConfig>;
  private statistics: HubStatistics;
  private forwardCallback?: FrameForwardCallback;

  constructor(id: string, name: string, portCount: number = 8) {
    super(id, name, 'hub');

    this.portCount = portCount;
    this.portConfigs = new Map();
    this.statistics = {
      totalFrames: 0
    };

    // Create ports
    for (let i = 0; i < portCount; i++) {
      const portName = `eth${i}`;
      this.addPort(portName);

      // Initialize port config
      this.portConfigs.set(portName, {
        enabled: true
      });
    }
  }

  /**
   * Powers on the hub
   */
  public powerOn(): void {
    this.status = 'online';
  }

  /**
   * Powers off the hub
   */
  public powerOff(): void {
    this.status = 'offline';
  }

  /**
   * Resets the hub
   * Clears statistics
   */
  public reset(): void {
    this.statistics = {
      totalFrames: 0
    };
    this.powerOff();
    this.powerOn();
  }

  /**
   * Receives frame on port
   * Repeats frame to all other enabled ports
   *
   * @param port - Port where frame was received
   * @param frame - Ethernet frame
   */
  public receiveFrame(port: string, frame: EthernetFrame): void {
    if (!this.isOnline()) {
      return; // Drop if hub is offline
    }

    // Check if ingress port is enabled
    const portConfig = this.portConfigs.get(port);
    if (!portConfig || !portConfig.enabled) {
      return; // Drop if port is disabled
    }

    this.statistics.totalFrames++;

    // Repeat to all other enabled ports
    for (const [targetPort, config] of this.portConfigs.entries()) {
      // Skip ingress port and disabled ports
      if (targetPort === port || !config.enabled) {
        continue;
      }

      if (this.forwardCallback) {
        this.forwardCallback(targetPort, frame);
      }
    }
  }

  /**
   * Registers callback for frame forwarding
   *
   * @param callback - Function to call when frame should be forwarded
   */
  public onFrameForward(callback: FrameForwardCallback): void {
    this.forwardCallback = callback;
  }

  /**
   * Returns statistics
   */
  public getStatistics(): Readonly<HubStatistics> {
    return { ...this.statistics };
  }

  /**
   * Enables port
   *
   * @param port - Port name
   */
  public enablePort(port: string): void {
    const config = this.portConfigs.get(port);
    if (config) {
      config.enabled = true;
    }
  }

  /**
   * Disables port
   *
   * @param port - Port name
   */
  public disablePort(port: string): void {
    const config = this.portConfigs.get(port);
    if (config) {
      config.enabled = false;
    }
  }

  /**
   * Checks if port is enabled
   *
   * @param port - Port name
   * @returns True if port is enabled
   */
  public isPortEnabled(port: string): boolean {
    const config = this.portConfigs.get(port);
    return config ? config.enabled : false;
  }

  /**
   * Returns port count
   */
  public getPortCount(): number {
    return this.portCount;
  }
}
