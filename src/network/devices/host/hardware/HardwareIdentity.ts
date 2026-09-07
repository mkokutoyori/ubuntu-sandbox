import { simulatedDigest } from '@/network/dns/dnssec/Digest';

export function uuidFromSeed(seed: string): string {
  const h = simulatedDigest(seed);
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
}

export function smbiosUuidFor(seed: string): string {
  return uuidFromSeed(`smbios:${seed}`).toUpperCase();
}

export function machineIdFor(seed: string): string {
  return simulatedDigest(`machine-id:${seed}`);
}

export function filesystemUuidFor(seed: string, partitionName: string): string {
  return uuidFromSeed(`filesystem:${seed}:${partitionName}`);
}
