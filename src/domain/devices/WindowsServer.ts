/**
 * WindowsServer - Windows Server
 *
 * Server with Windows Server commands and multiple interfaces.
 * Extends WindowsPC with server-specific features.
 */

import { WindowsPC } from './WindowsPC';
import { DeviceConfig } from './types';

export class WindowsServer extends WindowsPC {
  constructor(config: DeviceConfig) {
    // Servers have more interfaces by default
    const serverConfig = {
      ...config,
      interfaces: config.interfaces || [
        { id: 'eth0', name: 'eth0', type: 'ethernet' as const },
        { id: 'eth1', name: 'eth1', type: 'ethernet' as const },
        { id: 'eth2', name: 'eth2', type: 'ethernet' as const },
        { id: 'eth3', name: 'eth3', type: 'ethernet' as const }
      ]
    };

    super(serverConfig);

    // Override type
    (this as any).type = 'windows-server';

    // Set default hostname
    if (!config.hostname) {
      this.setHostname('SERVER');
    }
  }

  /**
   * Get device type
   */
  public getType(): string {
    return 'windows-server';
  }
}
