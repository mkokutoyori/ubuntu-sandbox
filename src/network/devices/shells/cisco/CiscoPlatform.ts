export interface CiscoSoftwareIdentity {
  readonly softwareId: string;
  readonly iosVersion: string;
  readonly image: string;
}

export const C2960_SOFTWARE: CiscoSoftwareIdentity = {
  softwareId: 'C2960-LANBASEK9-M',
  iosVersion: '15.0(2)SE11',
  image: 'c2960-lanbasek9-mz.150-2.SE.bin',
};

export function ciscoSoftwareDescriptor(
  sw: CiscoSoftwareIdentity,
  release?: string,
): string {
  const suffix = release ? `, ${release}` : '';
  const family = sw.softwareId.split('-')[0];
  return `Cisco IOS Software, ${family} Software (${sw.softwareId}), Version ${sw.iosVersion}${suffix}`;
}
