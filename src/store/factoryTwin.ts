import { createDevice, Logger, MACAddress, type Equipment } from '@/network';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

export function withFactoryTwin<T>(device: Equipment, inspect: (twin: Equipment) => T): T {
  return Logger.silenced(() => MACAddress.preservingCounter(() => EquipmentRegistry.isolated(() => {
    const twin = createDevice(device.getType(), 0, 0, device.getName());
    try {
      return inspect(twin);
    } finally {
      twin.dispose();
    }
  })));
}
