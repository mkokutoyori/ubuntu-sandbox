/**
 * SerialConnection - Serial/WAN link connection
 *
 * Simulates a serial point-to-point connection between two routers.
 * Used for WAN links with configurable clock rate and encapsulation.
 *
 * Features:
 * - Configurable clock rate (up to 8 Mbps)
 * - Encapsulation support (HDLC, PPP)
 * - DCE/DTE role assignment
 * - Point-to-point only
 *
 * @example
 * ```typescript
 * const serial = new SerialConnection({
 *   id: 'serial-1',
 *   sourceDeviceId: 'r1',
 *   sourceInterfaceId: 'serial0/0',
 *   targetDeviceId: 'r2',
 *   targetInterfaceId: 'serial0/0'
 * });
 *
 * serial.setClockRate(1544000); // T1 line
 * serial.setEncapsulation('ppp');
 * ```
 */

import { BaseConnection, ConnectionConfig } from './BaseConnection';
import { EthernetFrame } from '../network/entities/EthernetFrame';

/**
 * Serial encapsulation type
 */
export type SerialEncapsulation = 'hdlc' | 'ppp';

/**
 * DCE/DTE role
 */
export type SerialRole = 'dce' | 'dte';

/**
 * Common clock rates in bps
 */
export const COMMON_CLOCK_RATES = {
  T1: 1544000,
  E1: 2048000,
  T3: 44736000,
  '56K': 56000,
  '64K': 64000,
  '128K': 128000,
  '256K': 256000,
  '512K': 512000,
  '1M': 1000000,
  '2M': 2000000,
  '4M': 4000000,
  '8M': 8000000
} as const;

/**
 * Maximum serial frame size
 */
const MAX_SERIAL_FRAME_SIZE = 1500;

/**
 * SerialConnection - Represents a serial WAN link
 */
export class SerialConnection extends BaseConnection {
  private clockRate: number; // in bps
  private encapsulation: SerialEncapsulation;
  private sourceRole: SerialRole;

  constructor(config: ConnectionConfig) {
    super(config, 'serial');
    this.clockRate = COMMON_CLOCK_RATES.T1;
    this.encapsulation = 'hdlc';
    this.sourceRole = 'dce';
  }

  /**
   * Returns bandwidth in Mbps (derived from clock rate)
   */
  public getBandwidth(): number {
    return this.clockRate / 1_000_000;
  }

  /**
   * Returns latency in milliseconds
   * Serial links have higher latency than Ethernet
   */
  public getLatency(): number {
    // Approximate latency based on clock rate
    if (this.clockRate >= 4_000_000) return 1;
    if (this.clockRate >= 1_000_000) return 2;
    if (this.clockRate >= 256_000) return 5;
    return 10;
  }

  /**
   * Returns clock rate in bps
   */
  public getClockRate(): number {
    return this.clockRate;
  }

  /**
   * Sets clock rate in bps
   *
   * @param rate - Clock rate in bits per second
   * @throws {Error} If rate is out of valid range
   */
  public setClockRate(rate: number): void {
    if (rate < 1200 || rate > 8_000_000) {
      throw new Error(`Invalid clock rate: ${rate}. Must be between 1200 and 8000000 bps`);
    }
    this.clockRate = rate;
  }

  /**
   * Returns encapsulation type
   */
  public getEncapsulation(): SerialEncapsulation {
    return this.encapsulation;
  }

  /**
   * Sets encapsulation type
   */
  public setEncapsulation(encapsulation: SerialEncapsulation): void {
    this.encapsulation = encapsulation;
  }

  /**
   * Returns the role of the source device (DCE/DTE)
   */
  public getSourceRole(): SerialRole {
    return this.sourceRole;
  }

  /**
   * Sets the role of the source device
   * The target automatically gets the opposite role
   */
  public setSourceRole(role: SerialRole): void {
    this.sourceRole = role;
  }

  /**
   * Returns the role for a given device ID
   */
  public getDeviceRole(deviceId: string): SerialRole | null {
    if (deviceId === this.source.deviceId) {
      return this.sourceRole;
    }
    if (deviceId === this.target.deviceId) {
      return this.sourceRole === 'dce' ? 'dte' : 'dce';
    }
    return null;
  }

  /**
   * Validates frame size for serial link
   */
  protected validateFrame(frame: EthernetFrame): boolean {
    const frameSize = frame.getSize();
    return frameSize <= MAX_SERIAL_FRAME_SIZE;
  }

  /**
   * Serial-specific frame processing
   */
  protected processFrame(_frame: EthernetFrame): void {
    // In a more advanced simulation, we could:
    // - Add serialization delay based on clock rate
    // - Apply encapsulation overhead
    // - Simulate bit errors
  }
}
