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
import { PciBus } from './PciBus';
import { UsbBus } from './UsbBus';
import { filesystemUuidFor, smbiosUuidFor } from './HardwareIdentity';

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

/** The operating system a host's disks are laid out for. */
export type HostPlatform = 'linux' | 'windows';

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
  pciBus?: PciBus;
  usbBus?: UsbBus;
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
  pciBus: PciBus;
  usbBus: UsbBus;

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
    this.pciBus = init.pciBus ?? PciBus.defaultInventory();
    this.usbBus = init.usbBus ?? UsbBus.defaultInventory();
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

  /**
   * Preset for a Windows host. Its disks are NTFS and named by drive
   * letter, because that is the layout every Windows view describes —
   * `Get-Disk`, `Get-Partition`, `wmic diskdrive`, `fsutil`. Giving a
   * Windows box the Linux preset made its inventory announce `sda1`
   * mounted on `/` in `ext4`.
   */
  static windowsWorkstation(): HardwareProfile {
    return new HardwareProfile({
      manufacturer: 'QEMU',
      productName: 'Standard PC (i440FX + PIIX, 1996)',
      chassisType: 'Desktop',
      cpu: new CpuSpec(),
      memory: new MemoryProfile(),
      storage: [windowsSystemDisk(), windowsDataDisk()],
      adapters: [new NetworkAdapter({ name: 'eth0', macAddress: '52:54:00:12:34:56' })],
    });
  }

  static windowsServer(): HardwareProfile {
    return new HardwareProfile({
      manufacturer: 'QEMU',
      productName: 'Standard PC (Q35 + ICH9, 2009)',
      chassisType: 'Rack Mount Chassis',
      cpu: new CpuSpec(),
      memory: new MemoryProfile(),
      storage: [windowsSystemDisk(), windowsDataDisk()],
      adapters: [new NetworkAdapter({ name: 'eth0', macAddress: '52:54:00:12:34:56' })],
    });
  }

  /** Select the preset matching a host role and platform. */
  static defaultFor(role: HostRole, platform: HostPlatform = 'linux'): HardwareProfile {
    if (platform === 'windows') {
      return role === 'server' ? HardwareProfile.windowsServer() : HardwareProfile.windowsWorkstation();
    }
    return role === 'server' ? HardwareProfile.server() : HardwareProfile.workstation();
  }

  /**
   * Stamp the identity a hypervisor gives to ONE machine: the SMBIOS
   * system UUID libvirt assigns per domain, and the filesystem UUID
   * `mkfs` writes into each partition. Both are unique per install in
   * the real world, so two hosts of the same canvas must not share them.
   *
   * What is deliberately NOT stamped: the chassis serial, which a bare
   * QEMU guest genuinely leaves unset, and the disk serial, which QEMU
   * derives from the DRIVE INDEX (`QM00001`, `QM00002`) and which two
   * separate guests really do share.
   */
  identify(seed: string): void {
    this.productUuid = smbiosUuidFor(seed);
    for (const disk of this.storage) {
      disk.partitions = disk.partitions.map((p) => new DiskPartition({
        name: p.name,
        sizeBytes: p.sizeBytes,
        fsType: p.fsType,
        mountPoint: p.mountPoint,
        label: p.label,
        uuid: p.uuid || filesystemUuidFor(seed, p.name),
      }));
    }
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

/**
 * A 100 GiB data disk: `sdb1` → `/u01` (the Oracle mount). QEMU numbers
 * its IDE serials by drive index, so the second disk of a guest is
 * `QM00002` — `/dev/disk/by-id/ata-QEMU_HARDDISK_QM00002`.
 */
const MIB = 1024 ** 2;

/**
 * Le disque systeme d'une installation Windows en MBR : la partition
 * « System Reserved » de 549 Mio, sans lettre, puis `C:`. C'est
 * l'agencement que `Get-Partition` decrit sur un poste ordinaire.
 */
function windowsSystemDisk(): StorageDevice {
  return new StorageDevice({
    name: 'disk0',
    sizeBytes: 549 * MIB + 100 * GIB,
    model: 'Microsoft Virtual Disk',
    serial: 'QM00001',
    medium: 'HDD',
    partitions: [
      new DiskPartition({ name: 'disk0-part1', sizeBytes: 549 * MIB, fsType: 'NTFS', label: 'System Reserved' }),
      new DiskPartition({ name: 'disk0-part2', sizeBytes: 100 * GIB, fsType: 'NTFS', mountPoint: 'C:', label: 'Windows' }),
    ],
  });
}

/** Le second disque d'un poste Windows : `D:`, un volume de donnees. */
function windowsDataDisk(): StorageDevice {
  return new StorageDevice({
    name: 'disk1',
    sizeBytes: 50 * GIB,
    model: 'Virtual HD',
    serial: 'QM00002',
    medium: 'HDD',
    partitions: [
      new DiskPartition({ name: 'disk1-part1', sizeBytes: 50 * GIB, fsType: 'NTFS', mountPoint: 'D:', label: 'Data' }),
    ],
  });
}

function defaultDataDisk(): StorageDevice {
  return new StorageDevice({
    name: 'sdb',
    sizeBytes: 100 * GIB,
    model: 'QEMU HARDDISK',
    serial: 'QM00002',
    medium: 'HDD',
    partitions: [
      new DiskPartition({ name: 'sdb1', sizeBytes: 100 * GIB, fsType: 'ext4', mountPoint: '/u01' }),
    ],
  });
}
