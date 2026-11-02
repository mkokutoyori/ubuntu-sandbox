import type { DeviceType } from '../core/types';
import type { Equipment } from '../equipment/Equipment';

export type DeviceBuilder = (name: string, x: number, y: number) => Equipment;

const builders = new Map<DeviceType, DeviceBuilder>();

export function registerDeviceBuilder(type: DeviceType, builder: DeviceBuilder): void {
  builders.set(type, builder);
}

export function deviceBuilderFor(type: DeviceType): DeviceBuilder | undefined {
  return builders.get(type);
}

export function isDevicePlatformLoaded(type: DeviceType): boolean {
  return builders.has(type);
}
