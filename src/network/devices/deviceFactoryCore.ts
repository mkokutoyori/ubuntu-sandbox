import { DeviceType } from '../core/types';
import { DEVICE_CATALOG, hasTerminalSupport, isFullyImplemented } from '../core/deviceCatalog';
import { Equipment } from '../equipment/Equipment';
import { deviceBuilderFor } from './deviceBuilders';
import { hasDevicePlatform } from './platformLoaders';
import {
  nextDeviceName, resetDeviceCounters, reserveDeviceName,
} from './deviceNameCounters';

export { resetDeviceCounters, reserveDeviceName, hasTerminalSupport, isFullyImplemented };

export function createDevice(type: DeviceType, x: number = 0, y: number = 0, restoredName?: string): Equipment {
  const builder = deviceBuilderFor(type);
  if (builder === undefined) {
    if (!hasDevicePlatform(type)) throw new Error(`Unknown device type: ${type}`);
    throw new Error(`Device platform for "${type}" is not loaded: await loadDevicePlatform("${type}") first`);
  }
  const name = restoredName ?? nextDeviceName(DEVICE_CATALOG[type]?.namePrefix ?? type);
  return builder(name, x, y);
}
