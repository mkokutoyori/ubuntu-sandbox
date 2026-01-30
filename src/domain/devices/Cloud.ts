/**
 * Cloud - Internet/Cloud representation
 *
 * Represents external network connectivity (Internet, WAN, Cloud services).
 */

import { BaseDevice, DeviceType } from './BaseDevice';
import { DeviceConfig, OSType } from './types';
import { NetworkInterface } from './NetworkInterface';
import { MACAddress } from '../network/value-objects/MACAddress';

// Generate a random MAC address
function generateRandomMAC(): MACAddress {
  const bytes: number[] = [];
  for (let i = 0; i < 6; i++) {
    bytes.push(Math.floor(Math.random() * 256));
  }
  // Set locally administered and unicast bits
  bytes[0] = (bytes[0] & 0xFC) | 0x02;
  return MACAddress.fromBytes(bytes);
}

export class Cloud extends BaseDevice {
  private interfaces: Map<string, NetworkInterface>;

  constructor(config: DeviceConfig) {
    const id = config.id || `cloud-${Date.now()}`;
    const name = config.name || 'Internet';

    super(id, name, 'cloud' as DeviceType);

    // Set hostname
    this.setHostname(config.hostname || 'Internet');

    // Set position if provided
    if (config.x !== undefined && config.y !== undefined) {
      this.setPosition(config.x, config.y);
    }

    // Create interfaces for connections
    this.interfaces = new Map();

    for (let i = 0; i < 4; i++) {
      const iface = new NetworkInterface(`eth${i}`, generateRandomMAC());
      this.interfaces.set(`eth${i}`, iface);
      this.addPort(`eth${i}`);
    }

    // Power on if requested
    if (config.isPoweredOn !== false) {
      this.powerOn();
    }
  }

  /**
   * Get OS type
   */
  public getOSType(): OSType {
    return 'unknown';
  }

  /**
   * Power on
   */
  public powerOn(): void {
    this.status = 'online';
  }

  /**
   * Power off
   */
  public powerOff(): void {
    this.status = 'offline';
  }

  /**
   * Reset
   */
  public reset(): void {
    this.powerOff();
    this.powerOn();
  }

  /**
   * Get all interfaces
   */
  public getInterfaces(): NetworkInterface[] {
    return Array.from(this.interfaces.values());
  }

  /**
   * Get interface by name
   */
  public getInterface(name: string): NetworkInterface | undefined {
    return this.interfaces.get(name);
  }

  /**
   * Execute command - Cloud doesn't have a terminal
   */
  public async executeCommand(_command: string): Promise<string> {
    return 'Cloud node does not support terminal access';
  }
}
