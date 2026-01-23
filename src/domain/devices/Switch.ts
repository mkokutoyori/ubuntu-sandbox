/**
 * Switch (Layer 2) Device
 *
 * Represents an Ethernet switch with:
 * - Multiple ports
 * - MAC address learning
 * - Frame forwarding (unicast, broadcast, multicast)
 * - VLAN support
 * - Port enable/disable
 *
 * Design Pattern: Composite + Strategy
 * - Composes MACTableService and FrameForwardingService
 * - Uses Strategy pattern for forwarding decisions
 *
 * @example
 * ```typescript
 * const sw = new Switch('sw1', 'Core Switch', 24); // 24-port switch
 *
 * sw.powerOn();
 *
 * sw.onFrameForward((port, frame) => {
 *   // Forward frame to specified port
 *   connectedDevice.receiveFrame(port, frame);
 * });
 *
 * sw.receiveFrame('eth0', frame);
 * ```
 */

import { BaseDevice } from './BaseDevice';
import { MACTableService } from '../network/services/MACTableService';
import { FrameForwardingService, ForwardingStatistics } from '../network/services/FrameForwardingService';
import { EthernetFrame } from '../network/entities/EthernetFrame';
import { MACAddress } from '../network/value-objects/MACAddress';

/**
 * Frame forward callback type
 */
type FrameForwardCallback = (port: string, frame: EthernetFrame) => void;

/**
 * Port configuration
 */
interface PortConfig {
  enabled: boolean;
  vlan: number;
}

/**
 * Switch - Layer 2 Ethernet switch
 */
export class Switch extends BaseDevice {
  private readonly portCount: number;
  private readonly macTable: MACTableService;
  private readonly forwardingService: FrameForwardingService;
  private readonly portConfigs: Map<string, PortConfig>;
  private forwardCallback?: FrameForwardCallback;

  constructor(id: string, name: string, portCount: number = 8) {
    super(id, name, 'switch');

    this.portCount = portCount;
    this.macTable = new MACTableService();
    this.forwardingService = new FrameForwardingService(this.macTable);
    this.portConfigs = new Map();

    // Create ports
    const ports: string[] = [];
    for (let i = 0; i < portCount; i++) {
      const portName = `eth${i}`;
      ports.push(portName);
      this.addPort(portName);

      // Initialize port config
      this.portConfigs.set(portName, {
        enabled: true,
        vlan: 1 // Default VLAN
      });
    }

    // Configure forwarding service with ports
    this.forwardingService.setPorts(ports);
  }

  /**
   * Powers on the switch
   */
  public powerOn(): void {
    this.status = 'online';
  }

  /**
   * Powers off the switch
   */
  public powerOff(): void {
    this.status = 'offline';
  }

  /**
   * Resets the switch
   * Clears MAC table and resets statistics
   */
  public reset(): void {
    this.macTable.clear();
    this.forwardingService.resetStatistics();
    this.macTable.resetStatistics();
    this.powerOff();
    this.powerOn();
  }

  /**
   * Receives frame on port
   *
   * @param port - Port where frame was received
   * @param frame - Ethernet frame
   */
  public receiveFrame(port: string, frame: EthernetFrame): void {
    if (!this.isOnline()) {
      return; // Drop if switch is offline
    }

    // Check if port is enabled
    const portConfig = this.portConfigs.get(port);
    if (!portConfig || !portConfig.enabled) {
      return; // Drop if port is disabled
    }

    // Forward frame
    const decision = this.forwardingService.forward(frame, port);

    // Filter by VLAN
    const ingressVLAN = portConfig.vlan;
    let eligiblePorts = decision.ports;

    if (decision.action === 'flood' || decision.action === 'forward') {
      // Only forward to ports in same VLAN
      eligiblePorts = decision.ports.filter(p => {
        const config = this.portConfigs.get(p);
        return config && config.enabled && config.vlan === ingressVLAN;
      });
    }

    // Forward to eligible ports
    for (const targetPort of eligiblePorts) {
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
   * Returns MAC table
   */
  public getMACTable(): MACTableService {
    return this.macTable;
  }

  /**
   * Returns forwarding statistics
   */
  public getForwardingStatistics(): Readonly<ForwardingStatistics> {
    return this.forwardingService.getStatistics();
  }

  /**
   * Returns MAC table statistics
   */
  public getMACTableStatistics() {
    return this.macTable.getStatistics();
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
   * Also removes MAC entries learned on this port
   *
   * @param port - Port name
   */
  public disablePort(port: string): void {
    const config = this.portConfigs.get(port);
    if (config) {
      config.enabled = false;
      this.macTable.removePort(port);
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
   * Sets port VLAN
   *
   * @param port - Port name
   * @param vlan - VLAN ID (1-4094)
   */
  public setPortVLAN(port: string, vlan: number): void {
    if (vlan < 1 || vlan > 4094) {
      throw new Error(`Invalid VLAN ID: ${vlan}`);
    }

    const config = this.portConfigs.get(port);
    if (config) {
      config.vlan = vlan;
    }
  }

  /**
   * Gets port VLAN
   *
   * @param port - Port name
   * @returns VLAN ID
   */
  public getPortVLAN(port: string): number {
    const config = this.portConfigs.get(port);
    return config ? config.vlan : 1;
  }

  /**
   * Returns port count
   */
  public getPortCount(): number {
    return this.portCount;
  }
}
