/**
 * LinuxServer - Ubuntu/CentOS Server
 *
 * Server with multiple network interfaces and Linux commands.
 * Extends LinuxPC with server-specific features.
 *
 * Design: Uses parent's interface management to ensure command inheritance works properly.
 */

import { LinuxPC } from './LinuxPC';
import { DeviceConfig } from './types';
import { NetworkInterface } from './NetworkInterface';
import { MACAddress } from '../network/value-objects/MACAddress';

export class LinuxServer extends LinuxPC {
  constructor(config: DeviceConfig) {
    super(config);

    // Override type
    (this as any).type = 'linux-server';

    // Set default hostname
    if (!config.hostname) {
      this.setHostname('server');
    }

    // Add additional server interfaces (servers have 4 NICs: eth0-eth3)
    // eth0 is already created by PC parent, we add eth1, eth2, eth3
    this.addServerInterfaces();
  }

  /**
   * Adds additional server network interfaces
   */
  private addServerInterfaces(): void {
    const additionalInterfaces = ['eth1', 'eth2', 'eth3'];

    for (const name of additionalInterfaces) {
      if (!this.hasInterface(name)) {
        const mac = this.generateServerMAC();
        const iface = new NetworkInterface(name, mac);
        this.addInterfaceToParent(name, iface);
        if (!this.hasPort(name)) {
          this.addPort(name);
        }
      }
    }
  }

  /**
   * Generates a random MAC address for server interfaces
   */
  private generateServerMAC(): MACAddress {
    const bytes = new Array(6);
    bytes[0] = 0x02; // Locally administered
    for (let i = 1; i < 6; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
    const macStr = bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
    return new MACAddress(macStr);
  }

  /**
   * Get device type
   */
  public getType(): string {
    return 'linux-server';
  }
}
