/**
 * Printer - Network Printer
 *
 * Network-attached printer with ethernet interface.
 */

import { BaseDevice, DeviceType } from './BaseDevice';
import { DeviceConfig, OSType } from './types';
import { NetworkInterface } from './NetworkInterface';

export class Printer extends BaseDevice {
  private interfaces: Map<string, NetworkInterface>;
  private model: string;

  constructor(config: DeviceConfig) {
    const id = config.id || `printer-${Date.now()}`;
    const name = config.name || id;

    super(id, name, 'printer' as DeviceType);

    // Set hostname
    this.setHostname(config.hostname || 'Printer');

    // Set position if provided
    if (config.x !== undefined && config.y !== undefined) {
      this.setPosition(config.x, config.y);
    }

    // Create interface
    this.interfaces = new Map();

    const eth0 = new NetworkInterface('eth0', 'eth0');
    this.interfaces.set('eth0', eth0);
    this.addPort('eth0');

    // Default model
    this.model = 'Generic Network Printer';

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
   * Get printer model
   */
  public getModel(): string {
    return this.model;
  }

  /**
   * Set printer model
   */
  public setModel(model: string): void {
    this.model = model;
  }

  /**
   * Execute command - Web interface simulation
   */
  public async executeCommand(command: string): Promise<string> {
    if (!this.isOnline()) {
      return 'Printer is offline';
    }

    const cmd = command.trim().toLowerCase();

    if (cmd === 'status') {
      return `Printer Status:\n  Model: ${this.model}\n  Status: Ready`;
    }

    if (cmd === 'info' || cmd === 'network') {
      const eth0 = this.interfaces.get('eth0');
      const ip = eth0?.getIPAddress()?.toString() || 'Not configured';
      const mac = eth0?.getMAC().toString() || 'Unknown';
      return `Network Info:\n  IP Address: ${ip}\n  MAC Address: ${mac}`;
    }

    return 'Unknown command';
  }
}
