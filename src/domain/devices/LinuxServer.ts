/**
 * LinuxServer - Ubuntu/CentOS Server
 *
 * Server with multiple network interfaces and Linux commands.
 * Extends LinuxPC with server-specific features.
 */

import { LinuxPC } from './LinuxPC';
import { DeviceConfig } from './types';
import { NetworkInterface } from './NetworkInterface';

export class LinuxServer extends LinuxPC {
  private serverInterfaces: Map<string, NetworkInterface>;

  constructor(config: DeviceConfig) {
    super(config);

    // Override type
    (this as any).type = 'linux-server';

    // Set default hostname
    if (!config.hostname) {
      this.setHostname('server');
    }

    // Create additional server interfaces (servers have 4 NICs)
    this.serverInterfaces = new Map();
    const interfaceNames = ['eth0', 'eth1', 'eth2', 'eth3'];
    for (const name of interfaceNames) {
      const iface = new NetworkInterface(name, name);
      this.serverInterfaces.set(name, iface);
      if (!this.hasPort(name)) {
        this.addPort(name);
      }
    }
  }

  /**
   * Get device type
   */
  public getType(): string {
    return 'linux-server';
  }

  /**
   * Get all interfaces (overrides parent to include server interfaces)
   */
  public getInterfaces(): NetworkInterface[] {
    return Array.from(this.serverInterfaces.values());
  }

  /**
   * Get interface by name
   */
  public getInterface(name: string): NetworkInterface | undefined {
    return this.serverInterfaces.get(name) || super.getInterface(name);
  }
}
