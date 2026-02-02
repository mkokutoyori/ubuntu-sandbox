/**
 * EthernetConnection - Standard Ethernet cable connection
 *
 * Simulates a physical Ethernet cable between two devices.
 * Supports different Ethernet standards (10BASE-T, 100BASE-TX, 1000BASE-T).
 *
 * Features:
 * - Bandwidth simulation (10/100/1000 Mbps)
 * - Full/Half duplex support
 * - MTU enforcement
 * - Cable type identification (straight-through, crossover)
 *
 * @example
 * ```typescript
 * const cable = new EthernetConnection({
 *   id: 'eth-conn-1',
 *   sourceDeviceId: 'pc1',
 *   sourceInterfaceId: 'eth0',
 *   targetDeviceId: 'sw1',
 *   targetInterfaceId: 'eth0'
 * });
 *
 * cable.setStandard('gigabit');
 * cable.transmitFrame('pc1', frame);
 * ```
 */

import { BaseConnection, ConnectionConfig } from './BaseConnection';
import { EthernetFrame } from '../network/entities/EthernetFrame';

/**
 * Ethernet standard
 */
export type EthernetStandard = '10base-t' | '100base-tx' | '1000base-t';

/**
 * Duplex mode
 */
export type DuplexMode = 'half' | 'full';

/**
 * Cable type
 */
export type CableType = 'straight-through' | 'crossover' | 'auto';

/**
 * Bandwidth per standard in Mbps
 */
const STANDARD_BANDWIDTH: Record<EthernetStandard, number> = {
  '10base-t': 10,
  '100base-tx': 100,
  '1000base-t': 1000
};

/**
 * Default latency per standard in ms
 */
const STANDARD_LATENCY: Record<EthernetStandard, number> = {
  '10base-t': 0.5,
  '100base-tx': 0.1,
  '1000base-t': 0.05
};

/**
 * Maximum Ethernet frame size (standard MTU + headers)
 */
const MAX_ETHERNET_FRAME_SIZE = 1518;

/**
 * Maximum Jumbo frame size
 */
const MAX_JUMBO_FRAME_SIZE = 9216;

/**
 * EthernetConnection - Represents a physical Ethernet cable
 */
export class EthernetConnection extends BaseConnection {
  private standard: EthernetStandard;
  private duplex: DuplexMode;
  private cableType: CableType;
  private jumboFramesEnabled: boolean;

  constructor(config: ConnectionConfig) {
    super(config, 'ethernet');
    this.standard = '1000base-t';
    this.duplex = 'full';
    this.cableType = 'auto';
    this.jumboFramesEnabled = false;
  }

  /**
   * Returns bandwidth in Mbps
   */
  public getBandwidth(): number {
    return STANDARD_BANDWIDTH[this.standard];
  }

  /**
   * Returns latency in milliseconds
   */
  public getLatency(): number {
    return STANDARD_LATENCY[this.standard];
  }

  /**
   * Returns the Ethernet standard
   */
  public getStandard(): EthernetStandard {
    return this.standard;
  }

  /**
   * Sets the Ethernet standard
   */
  public setStandard(standard: EthernetStandard): void {
    this.standard = standard;
  }

  /**
   * Returns duplex mode
   */
  public getDuplex(): DuplexMode {
    return this.duplex;
  }

  /**
   * Sets duplex mode
   */
  public setDuplex(duplex: DuplexMode): void {
    this.duplex = duplex;
  }

  /**
   * Returns cable type
   */
  public getCableType(): CableType {
    return this.cableType;
  }

  /**
   * Sets cable type
   */
  public setCableType(cableType: CableType): void {
    this.cableType = cableType;
  }

  /**
   * Enables or disables jumbo frame support
   */
  public setJumboFrames(enabled: boolean): void {
    this.jumboFramesEnabled = enabled;
  }

  /**
   * Returns whether jumbo frames are enabled
   */
  public isJumboFramesEnabled(): boolean {
    return this.jumboFramesEnabled;
  }

  /**
   * Validates frame size against Ethernet constraints
   */
  protected validateFrame(frame: EthernetFrame): boolean {
    const frameSize = frame.getSize();
    const maxSize = this.jumboFramesEnabled ? MAX_JUMBO_FRAME_SIZE : MAX_ETHERNET_FRAME_SIZE;

    if (frameSize > maxSize) {
      return false;
    }

    return true;
  }

  /**
   * No special processing needed for Ethernet frames
   */
  protected processFrame(_frame: EthernetFrame): void {
    // Standard Ethernet - no additional processing needed
    // In a more advanced simulation, we could add:
    // - Collision simulation for half-duplex
    // - Delay based on bandwidth/latency
    // - Error injection
  }
}
