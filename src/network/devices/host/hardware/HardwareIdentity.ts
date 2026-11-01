import { simulatedDigest } from '@/network/dns/dnssec/Digest';

export function dashedUuid(hex: string): string {
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

export function randomUuidBits(hex: string): string {
  const variant = (parseInt(hex[16], 16) & 0x3 | 0x8).toString(16);
  return `${hex.slice(0, 12)}4${hex.slice(13, 16)}${variant}${hex.slice(17, 32)}`;
}

export function uuidFromSeed(seed: string): string {
  return dashedUuid(simulatedDigest(seed));
}

export function smbiosUuidFor(seed: string): string {
  return uuidFromSeed(`smbios:${seed}`).toUpperCase();
}

export function machineIdFor(seed: string): string {
  return simulatedDigest(`machine-id:${seed}`);
}

export function bootIdFor(seed: string): string {
  return randomUuidBits(simulatedDigest(`boot-id:${seed}`));
}

export function filesystemUuidFor(seed: string, partitionName: string): string {
  return uuidFromSeed(`filesystem:${seed}:${partitionName}`);
}

export function interfaceGuidFor(seed: string, adapterName: string): string {
  return `{${uuidFromSeed(`netcfginstance:${seed}:${adapterName}`).toUpperCase()}}`;
}
