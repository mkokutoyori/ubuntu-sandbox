/**
 * IPPhone - VoIP Phone
 *
 * IP telephone with network interface and optional PC passthrough port.
 */

import { BaseDevice, DeviceType } from './BaseDevice';
import { DeviceConfig, OSType } from './types';
import { NetworkInterface } from './NetworkInterface';

export class IPPhone extends BaseDevice {
  private interfaces: Map<string, NetworkInterface>;
  private extension: string;

  constructor(config: DeviceConfig) {
    const id = config.id || `phone-${Date.now()}`;
    const name = config.name || id;

    super(id, name, 'ip-phone' as DeviceType);

    // Set hostname
    this.setHostname(config.hostname || 'Phone');

    // Set position if provided
    if (config.x !== undefined && config.y !== undefined) {
      this.setPosition(config.x, config.y);
    }

    // Create interfaces
    // eth0 = SW (switch/network uplink)
    // eth1 = PC (passthrough port for PC)
    this.interfaces = new Map();

    const eth0 = new NetworkInterface('eth0', 'eth0');
    this.interfaces.set('eth0', eth0);
    this.addPort('eth0');

    const eth1 = new NetworkInterface('eth1', 'eth1');
    this.interfaces.set('eth1', eth1);
    this.addPort('eth1');

    // Default extension
    this.extension = '1000';

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
   * Get phone extension
   */
  public getExtension(): string {
    return this.extension;
  }

  /**
   * Set phone extension
   */
  public setExtension(ext: string): void {
    this.extension = ext;
  }

  /**
   * Execute command - Limited phone interface
   */
  public async executeCommand(command: string): Promise<string> {
    if (!this.isOnline()) {
      return 'Phone is offline';
    }

    const cmd = command.trim().toLowerCase();

    if (cmd === 'status') {
      return `Phone Status:\n  Extension: ${this.extension}\n  Status: ${this.isOnline() ? 'Online' : 'Offline'}`;
    }

    if (cmd === 'network') {
      const eth0 = this.interfaces.get('eth0');
      const ip = eth0?.getIPAddress()?.toString() || 'Not configured';
      return `Network Info:\n  IP Address: ${ip}`;
    }

    return 'Unknown command';
  }
}
