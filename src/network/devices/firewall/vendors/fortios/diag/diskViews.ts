import type { LogDiskSpec } from '../../../FirewallProfile';

export function gibibytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}

export function partitionDevice(disk: LogDiskSpec): string {
  return `${disk.device}${disk.partitionRef}`;
}

export function partitionLabel(serial: string): string {
  let hash = 0x811c9dc5;
  for (const character of serial) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0;
  }
  return (hash.toString(16) + serial.slice(-8)).toUpperCase().slice(0, 16);
}

export function renderDiskList(
  disk: LogDiskSpec, serial: string, usedBytes: number,
): string {
  const free = Math.max(0, disk.partitionBytes - usedBytes);
  return [
    `Disk ${disk.label}(boot) ref: ${gibibytes(disk.capacityBytes)}`
    + ` type: ${disk.type} [${disk.model}] dev: ${disk.device}`,
    `partition ref: ${disk.partitionRef} ${gibibytes(disk.partitionBytes)},`
    + ` ${gibibytes(free)} free mounted: Y label: ${partitionLabel(serial)}`
    + ` dev: ${partitionDevice(disk)}`,
  ].join('\n');
}

export function renderScanRequest(disk: LogDiskSpec): string {
  return `scan requested for: ${disk.partitionRef}/${disk.label}`
    + ` (device=${partitionDevice(disk)})\nThis action requires the unit to reboot.`;
}
