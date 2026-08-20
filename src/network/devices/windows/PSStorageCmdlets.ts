import type { WindowsFileSystem } from './WindowsFileSystem';
import { parsePSArgs } from './psArgs';

export interface PSStorageContext {
  fs: WindowsFileSystem;
}

function listDisks(fs: WindowsFileSystem) {
  const fmtGB = (b: number) => `${Math.round(b / 1_073_741_824)} GB`;
  return fs.listDrives().map((d, i) => {
    const letter = d.charAt(0);
    const isC = letter === 'C';
    return {
      Number: i,
      FriendlyName: isC ? 'Microsoft Virtual Disk' : `Virtual HD ${letter}:`,
      UniqueId: `{00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}}`,
      SerialNumber: fs.getVolumeSerialNumber(letter).replace('-', ''),
      OperationalStatus: 'Online',
      TotalSize: fmtGB(fs.getDriveCapacity(letter)),
      PartitionStyle: 'MBR',
      IsBoot: isC,
      IsSystem: isC,
    };
  });
}

export function psGetDisk(ctx: PSStorageContext, args: string[]): string {
  const params = parsePSArgs(args);
  const numberFilter = params.get('number');
  const friendlyName = (params.get('friendlyname') ?? '').replace(/^["']|["']$/g, '');
  const uniqueId = (params.get('uniqueid') ?? '').replace(/^["']|["']$/g, '');
  const serialNumber = (params.get('serialnumber') ?? '').replace(/^["']|["']$/g, '');

  let disks = listDisks(ctx.fs);

  if (numberFilter !== undefined) {
    const num = parseInt(numberFilter, 10);
    disks = disks.filter(d => d.Number === num);
    if (disks.length === 0) return `Get-Disk : No MSFT_Disk objects found with Number = ${num}.\n    + CategoryInfo          : ObjectNotFound: (${num}:UInt32) [Get-Disk], CimException`;
  }
  if (friendlyName) {
    disks = disks.filter(d => d.FriendlyName.toLowerCase().includes(friendlyName.toLowerCase()));
    if (disks.length === 0) return `Get-Disk : No MSFT_Disk objects found with FriendlyName = '${friendlyName}'.`;
  }
  if (uniqueId) {
    disks = disks.filter(d => d.UniqueId === uniqueId);
    if (disks.length === 0) return `Get-Disk : No MSFT_Disk objects found with UniqueId = '${uniqueId}'.`;
  }
  if (serialNumber) {
    disks = disks.filter(d => d.SerialNumber === serialNumber);
    if (disks.length === 0) return `Get-Disk : No MSFT_Disk objects found with SerialNumber = '${serialNumber}'.`;
  }

  const header = [
    '',
    'Number FriendlyName                      OperationalStatus TotalSize PartitionStyle IsBoot IsSystem UniqueId',
    '------ ------------                      ----------------- --------- -------------- ------ -------- --------',
  ];
  const row = (d: ReturnType<typeof listDisks>[0]) =>
    `${String(d.Number).padEnd(7)}${d.FriendlyName.padEnd(34)}${d.OperationalStatus.padEnd(18)}${d.TotalSize.padEnd(10)}${d.PartitionStyle.padEnd(15)}${String(d.IsBoot).padEnd(7)}${String(d.IsSystem).padEnd(9)}${d.UniqueId}`;

  if (disks.length === 1) {
    const d = disks[0];
    return [
      ...header,
      row(d),
      '',
      `Number            : ${d.Number}`,
      `Friendly Name     : ${d.FriendlyName}`,
      `UniqueId          : ${d.UniqueId}`,
      `OperationalStatus : ${d.OperationalStatus}`,
      `PartitionStyle    : ${d.PartitionStyle}`,
      `TotalSize         : ${d.TotalSize}`,
      `IsBoot            : ${d.IsBoot}`,
      `IsSystem          : ${d.IsSystem}`,
    ].join('\n');
  }

  return [...header, ...disks.map(row)].join('\n');
}

export function psGetVolume(ctx: PSStorageContext, args: string[]): string {
  const params = parsePSArgs(args);
  const driveLetter = (params.get('driveletter') ?? params.get('_positional') ?? '').replace(/^["']|["']$/g, '').toUpperCase();

  const labels: Record<string, string> = { C: 'Windows', D: 'Data' };
  const fs = ctx.fs;
  const fmtGB = (bytes: number) => `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  const volumes = fs.listDrives()
    .map((d) => d.charAt(0))
    .map((letter) => ({
      DriveLetter: letter,
      FriendlyName: labels[letter] ?? 'Local Disk',
      FileSystem: 'NTFS',
      DriveType: 'Fixed',
      HealthStatus: 'Healthy',
      OperationalStatus: 'OK',
      SizeRemaining: fmtGB(fs.getFreeDiskSpace(letter)),
      Size: fmtGB(fs.getDriveCapacity(letter)),
    }));

  const filtered = driveLetter ? volumes.filter(v => v.DriveLetter === driveLetter) : volumes;
  if (driveLetter && filtered.length === 0) return `Get-Volume : No MSFT_Volume objects found with DriveLetter = ${driveLetter}.`;

  const header = [
    '',
    'DriveLetter FriendlyName FileSystem DriveType HealthStatus OperationalStatus SizeRemaining  Size',
    '----------- ------------ ---------- --------- ------------ ----------------- -------------  ----',
  ];
  const row = (v: typeof volumes[0]) =>
    `${v.DriveLetter.padEnd(12)}${v.FriendlyName.padEnd(13)}${v.FileSystem.padEnd(11)}${v.DriveType.padEnd(10)}${v.HealthStatus.padEnd(13)}${v.OperationalStatus.padEnd(18)}${v.SizeRemaining.padEnd(15)}${v.Size}`;

  if (filtered.length === 1) {
    const v = filtered[0];
    return [
      ...header,
      row(v),
      '',
      `DriveLetter       : ${v.DriveLetter}`,
      `FriendlyName      : ${v.FriendlyName}`,
      `FileSystem        : ${v.FileSystem}`,
      `DriveType         : ${v.DriveType}`,
      `HealthStatus      : ${v.HealthStatus}`,
      `OperationalStatus : ${v.OperationalStatus}`,
      `SizeRemaining     : ${v.SizeRemaining}`,
      `Size              : ${v.Size}`,
    ].join('\n');
  }

  return [...header, ...filtered.map(row)].join('\n');
}

export const STORAGE_CMDLETS: Record<string, (ctx: PSStorageContext, args: string[]) => string> = {
  'get-disk': psGetDisk,
  'get-volume': psGetVolume,
};
