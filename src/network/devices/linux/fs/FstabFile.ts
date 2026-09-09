import type { StorageDevice } from '@/network/devices/host/hardware';
import { partitionUuid } from '@/network/devices/host/hardware/partitionUuid';

export const FSTAB_PATH = '/etc/fstab';

const HEADER = [
  '# /etc/fstab: static file system information.',
  '#',
  "# Use 'blkid' to print the universally unique identifier for a",
  '# device; this may be used with UUID= as a more robust way to name devices',
  '# that works even if disks are added and removed. See fstab(5).',
  '#',
  '# <file system> <mount point>   <type>  <options>       <dump>  <pass>',
];

function optionsFor(mountPoint: string, fsType: string): string {
  if (fsType === 'swap') return 'sw';
  return mountPoint === '/' ? 'relatime,errors=remount-ro' : 'defaults';
}

function passFor(mountPoint: string, fsType: string): number {
  if (fsType === 'swap') return 0;
  return mountPoint === '/' ? 1 : 2;
}

export function renderFstab(storage: readonly StorageDevice[]): string {
  const lines = [...HEADER];
  for (const disk of storage) {
    for (const part of disk.partitions) {
      if (!part.mountPoint) continue;
      const fsType = part.fsType || 'ext4';
      lines.push([
        `UUID=${partitionUuid(part)}`,
        part.mountPoint,
        fsType,
        optionsFor(part.mountPoint, fsType),
        '0',
        String(passFor(part.mountPoint, fsType)),
      ].join(' '));
    }
  }
  return `${lines.join('\n')}\n`;
}
