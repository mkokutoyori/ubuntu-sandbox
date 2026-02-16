/**
 * DeviceFactory - Creates equipment instances by type
 */

import { DeviceType } from '../core/types';
import { Equipment } from '../equipment/Equipment';
import { LinuxPC } from './LinuxPC';
import { WindowsPC } from './WindowsPC';
import { CiscoSwitch } from './CiscoSwitch';
import { HuaweiSwitch } from './HuaweiSwitch';
import { GenericSwitch } from './GenericSwitch';
import { Hub } from './Hub';
import { Router } from './Router';

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
      return new LinuxPC('linux-pc', nextName('PC'), x, y);
    case 'windows-pc':
      return new WindowsPC('windows-pc', nextName('PC'), x, y);
    case 'mac-pc':
      return new LinuxPC('mac-pc', nextName('Mac'), x, y);

    // Servers
    case 'linux-server':
      return new LinuxPC('linux-server', nextName('Server'), x, y);
    case 'windows-server':
      return new WindowsPC('windows-server', nextName('WinServer'), x, y);

    // Switches
    case 'switch-cisco':
      return new CiscoSwitch('switch-cisco', nextName('Switch'), 24, x, y);
    case 'switch-huawei':
      return new HuaweiSwitch('switch-huawei', nextName('Switch'), 24, x, y);
    case 'switch-generic':
      return new GenericSwitch('switch-generic', nextName('Switch'), 24, x, y);
    case 'hub':
      return new Hub(nextName('Hub'), 8, x, y);

    // Routers
    case 'router-cisco':
      return new Router('router-cisco', nextName('Router'), x, y);
    case 'router-huawei':
      return new Router('router-huawei', nextName('Router'), x, y);

    // Firewalls (stub as LinuxPC for now)
    case 'firewall-cisco':
      return new LinuxPC('firewall-cisco', nextName('FW'), x, y);
    case 'firewall-fortinet':
      return new LinuxPC('firewall-fortinet', nextName('FW'), x, y);
    case 'firewall-paloalto':
      return new LinuxPC('firewall-paloalto', nextName('FW'), x, y);

    // Other
    case 'access-point':
      return new Hub(nextName('AP'), 4, x, y);
    case 'cloud':
      return new LinuxPC('cloud', nextName('Cloud'), x, y);

    default:
      throw new Error(`Unknown device type: ${type}`);
  }
}

export function hasTerminalSupport(type: DeviceType): boolean {
  switch (type) {
    case 'linux-pc':
    case 'windows-pc':
    case 'mac-pc':
    case 'linux-server':
    case 'windows-server':
    case 'switch-cisco':
    case 'switch-huawei':
    case 'switch-generic':
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

export function isFullyImplemented(type: DeviceType): boolean {
  switch (type) {
    case 'linux-pc':
    case 'windows-pc':
    case 'mac-pc':
    case 'linux-server':
    case 'windows-server':
    case 'switch-cisco':
    case 'switch-huawei':
    case 'switch-generic':
    case 'hub':
    case 'router-cisco':
    case 'router-huawei':
      return true;
    default:
      return false;
  }
}

export function resetDeviceCounters(): void {
  deviceCounters.clear();
  Equipment.clearRegistry();
}
