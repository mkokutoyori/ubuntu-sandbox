import type { DiskPartition } from './StorageDevice';

function synthUuid(seed: string): string {
  let h = 0;
  for (const c of seed) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  const u = (h >>> 0).toString(16).padStart(8, '0');
  return `${u}-${u.slice(0, 4)}-${u.slice(4, 8)}-${u.slice(0, 4)}-${u}${u.slice(0, 4)}`;
}

export function partitionUuid(part: DiskPartition): string {
  return part.uuid || synthUuid(part.name);
}

export function partitionPartUuid(part: DiskPartition): string {
  return synthUuid(`part-${part.name}`);
}
