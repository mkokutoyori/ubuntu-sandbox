// eslint-disable-next-line no-restricted-imports -- the name counters reset the registry they fill; they are not a device discovering peers
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const deviceCounters: Map<string, number> = new Map();

export function nextDeviceName(prefix: string): string {
  const count = (deviceCounters.get(prefix) || 0) + 1;
  deviceCounters.set(prefix, count);
  return `${prefix}${count}`;
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
