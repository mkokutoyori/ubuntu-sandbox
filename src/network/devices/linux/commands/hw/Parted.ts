import type { HardwareProfile } from '@/network/devices/host/hardware/HardwareProfile';
import type { StorageDevice } from '@/network/devices/host/hardware/StorageDevice';

export function cmdParted(profile: HardwareProfile, args: string[], _isPrivileged: boolean): { output: string; exitCode: number } {
  let list = false;
  const positional: string[] = [];
  for (const a of args) {
    if (a === '-l' || a === '--list') { list = true; continue; }
    if (a === '-h' || a === '--help') return { output: helpText(), exitCode: 0 };
    if (a === '-v' || a === '--version') return { output: 'parted (GNU parted) 3.4', exitCode: 0 };
    if (a.startsWith('-')) return { output: `parted: invalid option -- '${a.slice(1)}'`, exitCode: 1 };
    positional.push(a);
  }

  if (list || positional.length === 0) {
    return { output: profile.storage.map(d => renderDisk(d)).join('\n\n'), exitCode: 0 };
  }
  const target = positional[0];
  const subcommand = positional[1] ?? 'print';
  const disk = profile.storage.find(d => d.devicePath === target);
  if (!disk) return { output: `Error: Could not stat device ${target} - No such file or directory`, exitCode: 1 };
  if (subcommand === 'print') return { output: renderDisk(disk), exitCode: 0 };
  return { output: '', exitCode: 0 };
}

function renderDisk(disk: StorageDevice): string {
  const totalGib = (disk.sizeBytes / 1024 ** 3).toFixed(1);
  const lines: string[] = [
    `Model: ATA ${disk.model} (scsi)`,
    `Disk ${disk.devicePath}: ${totalGib}GB`,
    `Sector size (logical/physical): 512B/512B`,
    `Partition Table: msdos`,
    `Disk Flags:`,
    '',
    'Number  Start   End     Size    Type     File system  Flags',
  ];
  let start = 1.0;
  for (let i = 0; i < disk.partitions.length; i++) {
    const p = disk.partitions[i];
    const sizeGB = p.sizeBytes / 1024 ** 3;
    const endGB = start + sizeGB;
    lines.push(` ${i + 1}      ${start.toFixed(2)}GB  ${endGB.toFixed(2)}GB  ${sizeGB.toFixed(2)}GB  primary  ${p.fsType}`);
    start = endGB;
  }
  return lines.join('\n');
}

function helpText(): string {
  return 'Usage: parted [OPTION]... [DEVICE [COMMAND [PARAMETERS]...]...]';
}
