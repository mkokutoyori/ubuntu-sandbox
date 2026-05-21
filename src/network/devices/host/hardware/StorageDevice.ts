/**
 * StorageDevice — domain model of a host's block storage.
 *
 * A `StorageDevice` is a whole disk (`sda`, `nvme0n1`); it carries the
 * vendor metadata `lsblk`/`smartctl` expose plus the partition table. A
 * `DiskPartition` is one slice of that disk with its filesystem and mount
 * point — the level `df`, `mount` and `/etc/fstab` operate on.
 */

// ─── Partition (value object) ───────────────────────────────────────────

export interface DiskPartitionInit {
  name: string;
  sizeBytes: number;
  fsType?: string;
  mountPoint?: string;
  uuid?: string;
  label?: string;
}

/** One partition of a {@link StorageDevice}. */
export class DiskPartition {
  /** Kernel name, e.g. `sda1`. */
  readonly name: string;
  readonly sizeBytes: number;
  /** Filesystem type (`ext4`, `vfat`, `swap`, …); empty when unformatted. */
  readonly fsType: string;
  /** Mount point, or empty when not mounted. */
  readonly mountPoint: string;
  readonly uuid: string;
  readonly label: string;

  constructor(init: DiskPartitionInit) {
    this.name = init.name;
    this.sizeBytes = init.sizeBytes;
    this.fsType = init.fsType ?? '';
    this.mountPoint = init.mountPoint ?? '';
    this.uuid = init.uuid ?? '';
    this.label = init.label ?? '';
  }

  get sizeGib(): number {
    return this.sizeBytes / 1024 ** 3;
  }
}

// ─── Whole disk ─────────────────────────────────────────────────────────

/** Physical medium kind — drives the `rotational` flag and `lsblk` output. */
export type StorageMedium = 'HDD' | 'SSD' | 'NVMe';

export interface StorageDeviceInit {
  name: string;
  sizeBytes: number;
  model?: string;
  vendor?: string;
  serial?: string;
  medium?: StorageMedium;
  partitions?: DiskPartition[];
}

export class StorageDevice {
  /** Kernel name, e.g. `sda`. */
  name: string;
  sizeBytes: number;
  model: string;
  vendor: string;
  serial: string;
  medium: StorageMedium;
  partitions: DiskPartition[];

  constructor(init: StorageDeviceInit) {
    this.name = init.name;
    this.sizeBytes = init.sizeBytes;
    this.model = init.model ?? 'QEMU HARDDISK';
    this.vendor = init.vendor ?? 'ATA';
    this.serial = init.serial ?? 'QM00001';
    this.medium = init.medium ?? 'HDD';
    this.partitions = init.partitions ?? [];
  }

  /** Spinning media report `false` for SSD/NVMe (`/sys/block/<dev>/queue/rotational`). */
  get rotational(): boolean {
    return this.medium === 'HDD';
  }

  get sizeGib(): number {
    return this.sizeBytes / 1024 ** 3;
  }

  /** The `/dev/<name>` device node path. */
  get devicePath(): string {
    return `/dev/${this.name}`;
  }

  /** Partitions that are currently mounted. */
  mountedPartitions(): DiskPartition[] {
    return this.partitions.filter((p) => p.mountPoint !== '');
  }
}
