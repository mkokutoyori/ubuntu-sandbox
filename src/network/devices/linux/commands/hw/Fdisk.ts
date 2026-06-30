import type { HardwareProfile } from '@/network/devices/host/hardware/HardwareProfile';
import type { StorageDevice, DiskPartition } from '@/network/devices/host/hardware/StorageDevice';

interface Options {
  list: boolean;
  targets: string[];
}

const SECTOR_SIZE = 512;

export function cmdFdisk(profile: HardwareProfile, args: string[], _isPrivileged: boolean): { output: string; exitCode: number } {
  const parsed = parseArgs(args);
  if ('error' in parsed) return { output: parsed.error, exitCode: 1 };
  const opts = parsed.opts;

  if (!opts.list) return { output: 'fdisk: a command requires a device argument', exitCode: 1 };

  let disks: StorageDevice[] = profile.storage;
  if (opts.targets.length > 0) {
    const found: StorageDevice[] = [];
    for (const t of opts.targets) {
      const d = disks.find(x => x.devicePath === t);
      if (!d) return { output: `fdisk: cannot open ${t}: No such file or directory`, exitCode: 1 };
      found.push(d);
    }
    disks = found;
  }

  return { output: disks.map(d => renderDisk(d)).join('\n\n\n'), exitCode: 0 };
}

function parseArgs(args: string[]): { opts: Options } | { error: string } {
  const opts: Options = { list: false, targets: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-l' || a === '--list') { opts.list = true; continue; }
    if (a === '-h' || a === '--help') return { error: helpText() };
    if (a === '-V' || a === '--version') return { error: 'fdisk from util-linux 2.37' };
    if (a.startsWith('--')) return { error: `fdisk: unrecognized option '${a}'` };
    if (a.startsWith('-')) return { error: `fdisk: invalid option -- '${a.slice(1)}'` };
    opts.targets.push(a);
  }
  return { opts };
}

function renderDisk(disk: StorageDevice): string {
  const totalSectors = Math.floor(disk.sizeBytes / SECTOR_SIZE);
  const totalGib = (disk.sizeBytes / 1024 ** 3).toFixed(2);
  const lines: string[] = [
    `Disk ${disk.devicePath}: ${totalGib} GiB, ${disk.sizeBytes} bytes, ${totalSectors} sectors`,
    `Disk model: ${disk.model}`,
    `Units: sectors of 1 * ${SECTOR_SIZE} = ${SECTOR_SIZE} bytes`,
    `Sector size (logical/physical): ${SECTOR_SIZE} bytes / ${SECTOR_SIZE} bytes`,
    `I/O size (minimum/optimal): ${SECTOR_SIZE} bytes / ${SECTOR_SIZE} bytes`,
    `Disklabel type: dos`,
    `Disk identifier: 0x${pseudoId(disk.name)}`,
    '',
    'Device     Boot     Start       End   Sectors  Size Id Type',
  ];

  let cursor = 2048;
  let bootSet = false;
  for (const p of disk.partitions) {
    const sectors = Math.floor(p.sizeBytes / SECTOR_SIZE);
    const start = cursor;
    const end = cursor + sectors - 1;
    const boot = !bootSet && (p.mountPoint === '/boot' || (p.mountPoint === '/' && !disk.partitions.some(x => x.mountPoint === '/boot'))) ? '*' : ' ';
    if (boot === '*') bootSet = true;
    const sizeStr = humanSize(p.sizeBytes);
    const type = fsToType(p.fsType);
    lines.push(`${devNode(disk, p).padEnd(11)}${boot.padEnd(3)}${String(start).padStart(10)} ${String(end).padStart(9)} ${String(sectors).padStart(9)} ${sizeStr.padStart(5)} ${type.id} ${type.name}`);
    cursor = end + 1;
  }
  return lines.join('\n');
}

function devNode(disk: StorageDevice, p: DiskPartition): string {
  return `/dev/${p.name}`;
}

function fsToType(fs: string): { id: string; name: string } {
  switch (fs.toLowerCase()) {
    case 'ext2': case 'ext3': case 'ext4': case 'xfs': case 'btrfs':
      return { id: '83', name: 'Linux' };
    case 'swap':
      return { id: '82', name: 'Linux swap' };
    case 'vfat': case 'fat32':
      return { id: ' c', name: 'W95 FAT32 (LBA)' };
    case 'ntfs':
      return { id: ' 7', name: 'HPFS/NTFS/exFAT' };
    default:
      return { id: '83', name: 'Linux' };
  }
}

function humanSize(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(0)}G`;
  const mib = bytes / 1024 ** 2;
  return `${mib.toFixed(0)}M`;
}

function pseudoId(name: string): string {
  let h = 0;
  for (const c of name) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 8);
}

function helpText(): string {
  return [
    'Usage: fdisk [options] <disk>      change partition table',
    '       fdisk [options] -l [<disk>...] list partition table(s)',
    '',
    'Display or manipulate a disk partition table.',
    '',
    'Options:',
    ' -b, --sector-size <size>      physical and logical sector size',
    ' -c, --compatibility[=<mode>]  mode is "dos" or "nondos" (default)',
    ' -L, --color[=<when>]          colorize output (auto, always or never)',
    ' -l, --list                    display partitions and exit',
    ' -h, --help                    display this help',
    ' -V, --version                 display version',
  ].join('\n');
}
