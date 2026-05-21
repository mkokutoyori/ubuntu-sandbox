/**
 * HardwareProfile — the aggregate root of a host's hardware inventory.
 *
 * It binds together every hardware sub-model — CPU, memory, storage, network
 * adapters, firmware, motherboard — with the system-level identity (vendor,
 * product, chassis, SMBIOS UUID and serial). It is the single source of
 * truth a host exposes through `lscpu`, `free`, `/proc/*`, `dmidecode` and
 * Windows `systeminfo`.
 *
 * `HardwareProfile.workstation()` / `.server()` are factory presets; both
 * deliberately keep the CPU and memory figures the simulator shipped before
 * this model existed, so the model is a behaviour-preserving drop-in.
 */

import { CpuSpec } from './CpuSpec';
import { MemoryProfile } from './MemoryProfile';
import { StorageDevice, DiskPartition } from './StorageDevice';
import { NetworkAdapter } from './NetworkAdapter';
import { Firmware, Mainboard } from './SystemBoard';

/** SMBIOS chassis type — what `dmidecode -t chassis` reports. */
export type ChassisType =
  | 'Desktop'
  | 'Tower'
  | 'Laptop'
  | 'Notebook'
  | 'Rack Mount Chassis'
  | 'Other';

/** Intended role of a host — selects a sensible hardware preset. */
export type HostRole = 'workstation' | 'server';

export interface HardwareProfileInit {
  manufacturer?: string;
  productName?: string;
  productUuid?: string;
  serialNumber?: string;
  chassisType?: ChassisType;
  cpu?: CpuSpec;
  memory?: MemoryProfile;
  storage?: StorageDevice[];
  adapters?: NetworkAdapter[];
  firmware?: Firmware;
  mainboard?: Mainboard;
}

const GIB = 1024 ** 3;

export class HardwareProfile {
  manufacturer: string;
  productName: string;
  /** SMBIOS system UUID (`dmidecode -s system-uuid`). */
  productUuid: string;
  serialNumber: string;
  chassisType: ChassisType;
  cpu: CpuSpec;
  memory: MemoryProfile;
  storage: StorageDevice[];
  adapters: NetworkAdapter[];
  firmware: Firmware;
  mainboard: Mainboard;

  constructor(init: HardwareProfileInit = {}) {
    this.manufacturer = init.manufacturer ?? 'QEMU';
    this.productName = init.productName ?? 'Standard PC (i440FX + PIIX, 1996)';
    this.productUuid = init.productUuid ?? '00000000-0000-0000-0000-000000000000';
    this.serialNumber = init.serialNumber ?? 'Not Specified';
    this.chassisType = init.chassisType ?? 'Other';
    this.cpu = init.cpu ?? new CpuSpec();
    this.memory = init.memory ?? new MemoryProfile();
    this.storage = init.storage ?? [];
    this.adapters = init.adapters ?? [];
    this.firmware = init.firmware ?? new Firmware();
    this.mainboard = init.mainboard ?? new Mainboard();
  }

  // ─── Factory presets ───────────────────────────────────────────────────

  /** Preset for an interactive desktop/laptop host. */
  static workstation(): HardwareProfile {
    return new HardwareProfile({
      manufacturer: 'QEMU',
      productName: 'Standard PC (i440FX + PIIX, 1996)',
      chassisType: 'Desktop',
      cpu: new CpuSpec(),
      memory: new MemoryProfile(),
      storage: [defaultRootDisk()],
      adapters: [new NetworkAdapter({ name: 'eth0', macAddress: '52:54:00:12:34:56' })],
    });
  }

  /** Preset for a rack server — same CPU/RAM figures, server chassis & storage. */
  static server(): HardwareProfile {
    return new HardwareProfile({
      manufacturer: 'QEMU',
      productName: 'Standard PC (Q35 + ICH9, 2009)',
      chassisType: 'Rack Mount Chassis',
      cpu: new CpuSpec(),
      memory: new MemoryProfile(),
      storage: [defaultRootDisk(), defaultDataDisk()],
      adapters: [new NetworkAdapter({ name: 'eth0', macAddress: '52:54:00:12:34:56' })],
    });
  }

  /** Select the preset matching a host role. */
  static defaultFor(role: HostRole): HardwareProfile {
    return role === 'server' ? HardwareProfile.server() : HardwareProfile.workstation();
  }

  // ─── Derived accessors ─────────────────────────────────────────────────

  /** Every partition across every disk that is currently mounted. */
  mountedPartitions(): DiskPartition[] {
    return this.storage.flatMap((disk) => disk.mountedPartitions());
  }

  /** Total raw storage capacity in bytes. */
  get totalStorageBytes(): number {
    return this.storage.reduce((sum, disk) => sum + disk.sizeBytes, 0);
  }
}

// ─── Default disks ──────────────────────────────────────────────────────

/** A 50 GiB system disk: `sda1` → `/`, `sda2` → `/boot`. */
function defaultRootDisk(): StorageDevice {
  return new StorageDevice({
    name: 'sda',
    sizeBytes: 50 * GIB,
    model: 'QEMU HARDDISK',
    medium: 'HDD',
    partitions: [
      new DiskPartition({ name: 'sda1', sizeBytes: 48 * GIB, fsType: 'ext4', mountPoint: '/' }),
      new DiskPartition({ name: 'sda2', sizeBytes: 2 * GIB, fsType: 'ext4', mountPoint: '/boot' }),
    ],
  });
}

/** A 100 GiB data disk: `sdb1` → `/u01` (the Oracle mount). */
function defaultDataDisk(): StorageDevice {
  return new StorageDevice({
    name: 'sdb',
    sizeBytes: 100 * GIB,
    model: 'QEMU HARDDISK',
    medium: 'HDD',
    partitions: [
      new DiskPartition({ name: 'sdb1', sizeBytes: 100 * GIB, fsType: 'ext4', mountPoint: '/u01' }),
    ],
  });
}
