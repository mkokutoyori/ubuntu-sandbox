import { createDevice, Logger, MACAddress, type Equipment, type HostCapableDevice } from '@/network';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { getRegisteredOracleDatabase, initOracleFilesystem } from '@/terminal/commands/database';

export function withFactoryTwin<T>(device: Equipment, inspect: (twin: Equipment) => T): T {
  return Logger.silenced(() => MACAddress.preservingCounter(() => EquipmentRegistry.isolated(() => {
    const twin = createDevice(device.getType(), 0, 0, device.getName());
    try {
      if (getRegisteredOracleDatabase(device.getId())) initOracleFilesystem(twin as HostCapableDevice);
      return inspect(twin);
    } finally {
      twin.dispose();
    }
  })));
}
