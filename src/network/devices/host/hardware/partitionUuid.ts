import type { DiskPartition } from './StorageDevice';
import { uuidFromSeed } from './HardwareIdentity';

export function partitionUuid(part: DiskPartition): string {
  return part.uuid || uuidFromSeed(`filesystem:${part.name}`);
}

export function partitionPartUuid(part: DiskPartition): string {
  return uuidFromSeed(`partition:${partitionUuid(part)}`);
}
