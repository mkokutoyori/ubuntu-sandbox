/**
 * Host hardware inventory — public surface.
 *
 * A faithful, OS-agnostic domain model of a host's physical hardware,
 * shared by Linux and Windows machines. See `HardwareProfile` for the
 * aggregate root and its `workstation()` / `server()` factory presets.
 */

export { CpuSpec, type CpuSpecInit } from './CpuSpec';
export {
  MemoryProfile, MemoryModule, humanKib,
  type MemoryProfileInit, type MemoryModuleInit,
} from './MemoryProfile';
export {
  StorageDevice, DiskPartition,
  type StorageMedium, type StorageDeviceInit, type DiskPartitionInit,
} from './StorageDevice';
export { NetworkAdapter, type NetworkAdapterInit } from './NetworkAdapter';
export {
  Firmware, Mainboard,
  type FirmwareKind, type FirmwareInit, type MainboardInit,
} from './SystemBoard';
export {
  HardwareProfile,
  type HardwareProfileInit, type HostRole, type ChassisType,
} from './HardwareProfile';
