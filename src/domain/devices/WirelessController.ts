/**
 * WirelessController - Wireless LAN Controller (WLC)
 *
 * Centralized controller for managing multiple access points.
 */

import { BaseDevice, DeviceType } from './BaseDevice';
import { DeviceConfig, OSType } from './types';
import { NetworkInterface } from './NetworkInterface';

export class WirelessController extends BaseDevice {
  private interfaces: Map<string, NetworkInterface>;
  private managedAPs: string[];

  constructor(config: DeviceConfig) {
    const id = config.id || `wlc-${Date.now()}`;
    const name = config.name || id;

    super(id, name, 'wireless-controller' as DeviceType);

    // Set hostname
    this.setHostname(config.hostname || 'WLC');

    // Set position if provided
    if (config.x !== undefined && config.y !== undefined) {
      this.setPosition(config.x, config.y);
    }

    // Create interfaces (management + service ports)
    this.interfaces = new Map();

    for (let i = 0; i < 4; i++) {
      const iface = new NetworkInterface(`eth${i}`, `eth${i}`);
      this.interfaces.set(`eth${i}`, iface);
      this.addPort(`eth${i}`);
    }

    // Managed APs
    this.managedAPs = [];

    // Power on if requested
    if (config.isPoweredOn !== false) {
      this.powerOn();
    }
  }

  /**
   * Get OS type
   */
  public getOSType(): OSType {
    return 'cisco-ios';
  }

  /**
   * Power on the controller
   */
  public powerOn(): void {
    this.status = 'online';
  }

  /**
   * Power off the controller
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
   * Register an access point
   */
  public registerAP(apId: string): void {
    if (!this.managedAPs.includes(apId)) {
      this.managedAPs.push(apId);
    }
  }

  /**
   * Get managed APs
   */
  public getManagedAPs(): string[] {
    return [...this.managedAPs];
  }

  /**
   * Execute command
   */
  public async executeCommand(command: string): Promise<string> {
    if (!this.isOnline()) {
      return 'Device is offline';
    }

    const cmd = command.trim().toLowerCase();

    if (cmd === 'show ap summary') {
      if (this.managedAPs.length === 0) {
        return 'No APs registered';
      }
      return `Managed APs (${this.managedAPs.length}):\n${this.managedAPs.map(ap => `  - ${ap}`).join('\n')}`;
    }

    if (cmd === 'show interface summary' || cmd === 'show int sum') {
      let output = 'Interface Summary:\n';
      for (const iface of this.interfaces.values()) {
        output += `  ${iface.getName()}: ${iface.isUp() ? 'up' : 'down'}\n`;
      }
      return output;
    }

    return '';
  }

  /**
   * Get boot sequence
   */
  public getBootSequence(): string {
    return `
Cisco Wireless LAN Controller
Booting...

Copyright (c) 2020 Cisco Systems, Inc.
All rights reserved.

Initializing hardware...
Loading software...

${this.getHostname()} login:
`;
  }

  /**
   * Get prompt
   */
  public getPrompt(): string {
    return `(${this.getHostname()}) >`;
  }
}
