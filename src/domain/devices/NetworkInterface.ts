/**
 * NetworkInterface (NIC) - Network Interface Card
 *
 * Represents a physical or virtual network interface.
 * Handles frame transmission and reception at Layer 2.
 *
 * Features:
 * - MAC address assignment
 * - IP address configuration
 * - Frame TX/RX with callbacks
 * - Interface status (up/down)
 * - Statistics tracking
 * - MTU configuration
 * - Promiscuous mode
 *
 * @example
 * ```typescript
 * const mac = new MACAddress('AA:BB:CC:DD:EE:FF');
 * const nic = new NetworkInterface('eth0', mac);
 *
 * nic.setIPAddress(new IPAddress('192.168.1.10'), new SubnetMask('/24'));
 * nic.up();
 *
 * nic.onTransmit((frame) => {
 *   // Send frame to network
 * });
 *
 * nic.transmit(frame);
 * ```
 */

import { MACAddress } from '../network/value-objects/MACAddress';
import { IPAddress } from '../network/value-objects/IPAddress';
import { SubnetMask } from '../network/value-objects/SubnetMask';
import { EthernetFrame } from '../network/entities/EthernetFrame';

/**
 * Interface status
 */
export type InterfaceStatus = 'up' | 'down';

/**
 * Interface statistics
 */
export interface InterfaceStatistics {
  rxFrames: number;
  txFrames: number;
  rxBytes: number;
  txBytes: number;
  droppedFrames: number;
  errors: number;
}

/**
 * Frame callback type
 */
export type FrameCallback = (frame: EthernetFrame) => void;

/**
 * MTU constraints
 */
const MIN_MTU = 576; // Minimum IPv4 MTU
const MAX_MTU = 9216; // Jumbo frames
const DEFAULT_MTU = 1500; // Standard Ethernet MTU

/**
 * NetworkInterface - Represents a network interface card
 */
export class NetworkInterface {
  private readonly name: string;
  private readonly macAddress: MACAddress;
  private status: InterfaceStatus;
  private ipAddress?: IPAddress;
  private subnetMask?: SubnetMask;
  private gateway?: IPAddress;
  private mtu: number;
  private promiscuous: boolean;
  private statistics: InterfaceStatistics;
  private transmitCallbacks: FrameCallback[] = [];
  private receiveCallbacks: FrameCallback[] = [];

  constructor(name: string, macAddress: MACAddress) {
    this.name = name;
    this.macAddress = macAddress;
    this.status = 'down';
    this.mtu = DEFAULT_MTU;
    this.promiscuous = false;
    this.statistics = {
      rxFrames: 0,
      txFrames: 0,
      rxBytes: 0,
      txBytes: 0,
      droppedFrames: 0,
      errors: 0
    };
  }

  /**
   * Returns interface name
   */
  public getName(): string {
    return this.name;
  }

  /**
   * Returns MAC address
   */
  public getMAC(): MACAddress {
    return this.macAddress;
  }

  /**
   * Returns interface status
   */
  public getStatus(): InterfaceStatus {
    return this.status;
  }

  /**
   * Checks if interface is up
   */
  public isUp(): boolean {
    return this.status === 'up';
  }

  /**
   * Brings interface up
   */
  public up(): void {
    this.status = 'up';
  }

  /**
   * Brings interface down
   */
  public down(): void {
    this.status = 'down';
  }

  /**
   * Sets IP address and subnet mask
   *
   * @param ip - IP address
   * @param mask - Subnet mask
   */
  public setIPAddress(ip: IPAddress, mask: SubnetMask): void {
    this.ipAddress = ip;
    this.subnetMask = mask;
  }

  /**
   * Clears IP address configuration
   */
  public clearIPAddress(): void {
    this.ipAddress = undefined;
    this.subnetMask = undefined;
  }

  /**
   * Checks if IP address is configured
   */
  public hasIPAddress(): boolean {
    return this.ipAddress !== undefined;
  }

  /**
   * Returns IP address
   */
  public getIPAddress(): IPAddress | undefined {
    return this.ipAddress;
  }

  /**
   * Returns subnet mask
   */
  public getSubnetMask(): SubnetMask | undefined {
    return this.subnetMask;
  }

  /**
   * Sets default gateway
   *
   * @param gateway - Gateway IP address
   */
  public setGateway(gateway: IPAddress): void {
    this.gateway = gateway;
  }

  /**
   * Returns default gateway
   */
  public getGateway(): IPAddress | undefined {
    return this.gateway;
  }

  /**
   * Transmits frame
   *
   * @param frame - Ethernet frame to transmit
   * @throws {Error} If interface is down
   */
  public transmit(frame: EthernetFrame): void {
    if (!this.isUp()) {
      throw new Error('Interface is down');
    }

    this.statistics.txFrames++;
    this.statistics.txBytes += frame.getSize();

    // Call all registered transmit callbacks
    for (const callback of this.transmitCallbacks) {
      callback(frame);
    }
  }

  /**
   * Receives frame
   * Drops frame if not destined for this interface (unless promiscuous mode)
   *
   * @param frame - Ethernet frame received
   */
  public receive(frame: EthernetFrame): void {
    if (!this.isUp()) {
      return; // Silently drop when interface is down
    }

    const destMAC = frame.getDestinationMAC();

    // Check if frame is for us
    const isForUs =
      destMAC.equals(this.macAddress) ||
      destMAC.isBroadcast() ||
      (destMAC.isMulticast() && this.promiscuous); // Simplified multicast handling

    if (!isForUs && !this.promiscuous) {
      this.statistics.droppedFrames++;
      return;
    }

    this.statistics.rxFrames++;
    this.statistics.rxBytes += frame.getSize();

    // Call all registered receive callbacks
    for (const callback of this.receiveCallbacks) {
      callback(frame);
    }
  }

  /**
   * Registers callback for transmitted frames
   * Multiple callbacks can be registered and all will be called
   *
   * @param callback - Function to call when frame is transmitted
   */
  public onTransmit(callback: FrameCallback): void {
    this.transmitCallbacks.push(callback);
  }

  /**
   * Registers callback for received frames
   * Multiple callbacks can be registered and all will be called
   *
   * @param callback - Function to call when frame is received
   */
  public onReceive(callback: FrameCallback): void {
    this.receiveCallbacks.push(callback);
  }

  /**
   * Clears all transmit callbacks
   */
  public clearTransmitCallbacks(): void {
    this.transmitCallbacks = [];
  }

  /**
   * Clears all receive callbacks
   */
  public clearReceiveCallbacks(): void {
    this.receiveCallbacks = [];
  }

  /**
   * Returns MTU (Maximum Transmission Unit)
   */
  public getMTU(): number {
    return this.mtu;
  }

  /**
   * Sets MTU
   *
   * @param mtu - MTU in bytes
   * @throws {Error} If MTU is out of valid range
   */
  public setMTU(mtu: number): void {
    if (mtu < MIN_MTU) {
      throw new Error(`MTU too small: ${mtu} < ${MIN_MTU}`);
    }
    if (mtu > MAX_MTU) {
      throw new Error(`MTU too large: ${mtu} > ${MAX_MTU}`);
    }
    this.mtu = mtu;
  }

  /**
   * Checks if interface is in promiscuous mode
   */
  public isPromiscuous(): boolean {
    return this.promiscuous;
  }

  /**
   * Sets promiscuous mode
   * In promiscuous mode, interface receives all frames regardless of destination MAC
   *
   * @param enabled - True to enable, false to disable
   */
  public setPromiscuous(enabled: boolean): void {
    this.promiscuous = enabled;
  }

  /**
   * Returns interface statistics
   */
  public getStatistics(): Readonly<InterfaceStatistics> {
    return { ...this.statistics };
  }

  /**
   * Resets statistics
   */
  public resetStatistics(): void {
    this.statistics = {
      rxFrames: 0,
      txFrames: 0,
      rxBytes: 0,
      txBytes: 0,
      droppedFrames: 0,
      errors: 0
    };
  }
}
