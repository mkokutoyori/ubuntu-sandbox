/**
 * DeviceFactory - Creates equipment instances by type
 */

import { DeviceType } from '../core/types';
import { Equipment } from '../equipment/Equipment';
import { LinuxPC } from './LinuxPC';
import { WindowsPC } from './WindowsPC';
import { Switch } from './Switch';
import { Hub } from './Hub';

let deviceCounters: Map<string, number> = new Map();

function nextName(prefix: string): string {
  const count = (deviceCounters.get(prefix) || 0) + 1;
  deviceCounters.set(prefix, count);
  return `${prefix}${count}`;
}

export function createDevice(type: DeviceType, x: number = 0, y: number = 0): Equipment {
  switch (type) {
    // Computers
    case 'linux-pc':
      return new LinuxPC(nextName('PC'), x, y);
    case 'windows-pc':
      return new WindowsPC(nextName('PC'), x, y);
    case 'mac-pc':
      return new LinuxPC(nextName('Mac'), x, y);

    // Servers
    case 'linux-server':
      return new LinuxPC(nextName('Server'), x, y);
    case 'windows-server':
      return new WindowsPC(nextName('WinServer'), x, y);

    // Switches
    case 'switch-cisco':
      return new Switch('switch-cisco', nextName('Switch'), 24, x, y);
    case 'switch-huawei':
      return new Switch('switch-huawei', nextName('Switch'), 24, x, y);
    case 'switch-generic':
      return new Switch('switch-generic', nextName('Switch'), 24, x, y);
    case 'hub':
      return new Hub(nextName('Hub'), 8, x, y);

    // Routers (stub as LinuxPC for now)
    case 'router-cisco':
      return new LinuxPC(nextName('Router'), x, y);
    case 'router-huawei':
      return new LinuxPC(nextName('Router'), x, y);

    // Firewalls (stub as LinuxPC for now)
    case 'firewall-cisco':
      return new LinuxPC(nextName('FW'), x, y);
    case 'firewall-fortinet':
      return new LinuxPC(nextName('FW'), x, y);
    case 'firewall-paloalto':
      return new LinuxPC(nextName('FW'), x, y);

    // Other
    case 'access-point':
      return new Hub(nextName('AP'), 4, x, y);
    case 'cloud':
      return new LinuxPC(nextName('Cloud'), x, y);

    default:
      throw new Error(`Unknown device type: ${type}`);
  }
}

/**
 * Check if a device type supports terminal emulation
 */
export function hasTerminalSupport(type: DeviceType): boolean {
  switch (type) {
    case 'linux-pc':
    case 'windows-pc':
    case 'mac-pc':
    case 'linux-server':
    case 'windows-server':
    case 'router-cisco':
    case 'router-huawei':
    case 'firewall-cisco':
    case 'firewall-fortinet':
    case 'firewall-paloalto':
      return true;
    default:
      return false;
  }
}

/**
 * Check if a device type is fully implemented (vs stub)
 */
export function isFullyImplemented(type: DeviceType): boolean {
  switch (type) {
    case 'linux-pc':
    case 'windows-pc':
    case 'switch-cisco':
    case 'switch-huawei':
    case 'hub':
      return true;
    default:
      return false;
  }
}

export function resetDeviceCounters(): void {
  deviceCounters.clear();
}
