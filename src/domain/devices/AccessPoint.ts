/**
 * AccessPoint - Wireless Access Point
 *
 * Simple wireless access point with uplink interface.
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

export class AccessPoint extends BaseDevice {
  private interfaces: Map<string, NetworkInterface>;
  private ssids: string[];

  constructor(config: DeviceConfig) {
    const id = config.id || `ap-${Date.now()}`;
    const name = config.name || id;

    super(id, name, 'access-point' as DeviceType);

    // Set hostname
    this.setHostname(config.hostname || 'AccessPoint');

    // Set position if provided
    if (config.x !== undefined && config.y !== undefined) {
      this.setPosition(config.x, config.y);
    }

    // Create interfaces (uplink + optional PC port)
    this.interfaces = new Map();

    const eth0 = new NetworkInterface('eth0', generateRandomMAC());
    this.interfaces.set('eth0', eth0);
    this.addPort('eth0');

    const eth1 = new NetworkInterface('eth1', generateRandomMAC());
    this.interfaces.set('eth1', eth1);
    this.addPort('eth1');

    // Default SSIDs
    this.ssids = ['Default_SSID'];

    // Power on if requested
    if (config.isPoweredOn !== false) {
      this.powerOn();
    }
  }

  /**
   * Get OS type
   */
  public getOSType(): OSType {
    return 'linux';
  }

  /**
   * Power on the access point
   */
  public powerOn(): void {
    this.status = 'online';
  }

  /**
   * Power off the access point
   */
  public powerOff(): void {
    this.status = 'offline';
  }

  /**
   * Reset the access point
   */
  public reset(): void {
    this.powerOff();
    this.ssids = ['Default_SSID'];
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
   * Get SSIDs
   */
  public getSSIDs(): string[] {
    return [...this.ssids];
  }

  /**
   * Add SSID
   */
  public addSSID(ssid: string): void {
    if (!this.ssids.includes(ssid)) {
      this.ssids.push(ssid);
    }
  }

  /**
   * Execute command
   */
  public async executeCommand(command: string): Promise<string> {
    if (!this.isOnline()) {
      return 'Device is offline';
    }

    const cmd = command.trim().toLowerCase();

    if (cmd === 'show ssid' || cmd === 'show wlan') {
      return `SSIDs:\n${this.ssids.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`;
    }

    if (cmd === 'show interface' || cmd === 'show int') {
      let output = '';
      for (const iface of this.interfaces.values()) {
        output += `${iface.getName()}: ${iface.isUp() ? 'up' : 'down'}\n`;
      }
      return output;
    }

    return `Unknown command: ${command}`;
  }
}
