/**
 * ConsoleConnection - Console management cable connection
 *
 * Simulates a console cable (rollover/DB9) for device management.
 * Used to connect a PC to a router/switch console port for
 * initial configuration and out-of-band management.
 *
 * Features:
 * - Configurable baud rate
 * - Management-only traffic (no data plane)
 * - Point-to-point
 * - Does not carry Ethernet frames (management only)
 *
 * @example
 * ```typescript
 * const console = new ConsoleConnection({
 *   id: 'console-1',
 *   sourceDeviceId: 'pc1',
 *   sourceInterfaceId: 'console',
 *   targetDeviceId: 'r1',
 *   targetInterfaceId: 'console'
 * });
 *
 * console.setBaudRate(9600);
 * ```
 */

import { BaseConnection, ConnectionConfig } from './BaseConnection';
import { EthernetFrame } from '../network/entities/EthernetFrame';

/**
 * Common baud rates for console connections
 */
export const COMMON_BAUD_RATES = [
  1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200
] as const;

export type BaudRate = typeof COMMON_BAUD_RATES[number];

/**
 * ConsoleConnection - Represents a console management cable
 */
export class ConsoleConnection extends BaseConnection {
  private baudRate: number;

  constructor(config: ConnectionConfig) {
    super(config, 'console');
    this.baudRate = 9600; // Standard Cisco console default
  }

  /**
   * Console connections have minimal bandwidth (management only)
   * Returns bandwidth in Mbps
   */
  public getBandwidth(): number {
    return this.baudRate / 1_000_000;
  }

  /**
   * Returns latency in milliseconds
   * Console connections have high latency relative to data connections
   */
  public getLatency(): number {
    return 10;
  }

  /**
   * Returns baud rate
   */
  public getBaudRate(): number {
    return this.baudRate;
  }

  /**
   * Sets baud rate
   *
   * @param rate - Baud rate
   * @throws {Error} If rate is not a valid baud rate
   */
  public setBaudRate(rate: number): void {
    if (rate < 1200 || rate > 115200) {
      throw new Error(`Invalid baud rate: ${rate}. Must be between 1200 and 115200`);
    }
    this.baudRate = rate;
  }

  /**
   * Console connections don't carry data frames, so any frame is valid
   * (the console is used for management, not data plane traffic)
   */
  protected validateFrame(_frame: EthernetFrame): boolean {
    // Console connections primarily carry management traffic
    // We allow frames through for simulation simplicity
    return true;
  }

  /**
   * No processing needed for console connections
   */
  protected processFrame(_frame: EthernetFrame): void {
    // Console connections don't process data frames
  }
}
