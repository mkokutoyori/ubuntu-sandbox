/**
 * DeviceFactory - Creates equipment instances by type
 */

import { DeviceType } from '../core/types';
import { DEVICE_CATALOG } from '../core/deviceCatalog';
import { Equipment } from '../equipment/Equipment';
import { LinuxPC } from './LinuxPC';
import { LinuxServer } from './LinuxServer';
import { WindowsPC } from './WindowsPC';
import { WindowsServer } from './WindowsServer';
import { CiscoSwitch } from './CiscoSwitch';
import { HuaweiSwitch } from './HuaweiSwitch';
import { GenericSwitch } from './GenericSwitch';
import { Hub } from './Hub';
import { CiscoRouter } from './CiscoRouter';
import { HuaweiRouter } from './HuaweiRouter';
import { AsaFirewall } from './firewall/vendors/asa/AsaFirewall';
import { FortiGate } from './firewall/vendors/fortios/FortiGate';
// eslint-disable-next-line no-restricted-imports -- the factory resets the registry it fills; it is not a device discovering peers
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const deviceCounters: Map<string, number> = new Map();

function nextName(prefix: string): string {
  const count = (deviceCounters.get(prefix) || 0) + 1;
  deviceCounters.set(prefix, count);
  return `${prefix}${count}`;
}

export function createDevice(type: DeviceType, x: number = 0, y: number = 0, restoredName?: string): Equipment {
  const name = restoredName ?? nextName(DEVICE_CATALOG[type]?.namePrefix ?? type);
  switch (type) {
    // Computers
    case 'linux-pc':
      return new LinuxPC('linux-pc', name, x, y);
    case 'windows-pc':
      return new WindowsPC('windows-pc', name, x, y);
    case 'mac-pc':
      return new LinuxPC('mac-pc', name, x, y);

    // Servers
    case 'linux-server':
      return new LinuxServer('linux-server', name, x, y);
    case 'windows-server':
      return new WindowsServer(name, x, y);

    // Switches
    case 'switch-cisco':
      return new CiscoSwitch('switch-cisco', name, 26, x, y);
    case 'switch-huawei':
      return new HuaweiSwitch('switch-huawei', name, 24, x, y);
    case 'switch-generic':
      return new GenericSwitch('switch-generic', name, 24, x, y);
    case 'hub':
      return new Hub(name, 8, x, y);

    // Routers
    case 'router-cisco':
      return new CiscoRouter(name, x, y);
    case 'router-huawei':
      return new HuaweiRouter(name, x, y);

    // Firewalls (stub as LinuxPC for now)
    case 'firewall-cisco':
      return new AsaFirewall('firewall-cisco', name, x, y);
    case 'firewall-fortinet':
      return new FortiGate('firewall-fortinet', name, x, y);
    case 'firewall-paloalto':
      return new LinuxPC('firewall-paloalto', name, x, y);

    // Other
    case 'access-point':
      return new Hub(name, 4, x, y);
    case 'cloud':
      return new LinuxPC('cloud', name, x, y);

    default:
      throw new Error(`Unknown device type: ${type}`);
  }
}

export function hasTerminalSupport(type: DeviceType): boolean {
  return DEVICE_CATALOG[type]?.hasTerminal ?? false;
}

export function isFullyImplemented(type: DeviceType): boolean {
  return DEVICE_CATALOG[type]?.fullyImplemented ?? false;
}

export function resetDeviceCounters(): void {
  deviceCounters.clear();
  EquipmentRegistry.getInstance().clear();
}

export function reserveDeviceName(name: string): void {
  const match = /^(.*?)(\d+)$/.exec(name);
  if (!match) return;
  const [, prefix, digits] = match;
  const value = parseInt(digits, 10);
  if (!Number.isFinite(value)) return;
  if (value > (deviceCounters.get(prefix) ?? 0)) deviceCounters.set(prefix, value);
}
