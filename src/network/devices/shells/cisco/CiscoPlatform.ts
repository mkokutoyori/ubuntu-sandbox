import {
  IOS_ENCRYPTION_ALGORITHMS, IOS_KEX_GROUP1_SHA1, IOS_KEX_GROUP14_SHA1, IOS_KEX_GROUP_EXCHANGE_SHA1,
  IOS_PRE_CTR_ENCRYPTION_ALGORITHMS,
} from '../../router/security/CiscoSshAlgorithms';

export interface CiscoSoftwareIdentity {
  readonly softwareId: string;
  readonly iosVersion: string;
  readonly image: string;
  readonly sshEncryption: readonly string[];
  readonly sshKex: readonly string[];
}

export const C2960_SOFTWARE: CiscoSoftwareIdentity = {
  softwareId: 'C2960-LANBASEK9-M',
  iosVersion: '15.0(2)SE11',
  image: 'c2960-lanbasek9-mz.150-2.SE.bin',
  sshEncryption: IOS_PRE_CTR_ENCRYPTION_ALGORITHMS,
  sshKex: [IOS_KEX_GROUP_EXCHANGE_SHA1, IOS_KEX_GROUP1_SHA1],
};

export const C2900_SOFTWARE: CiscoSoftwareIdentity = {
  softwareId: 'C2900-UNIVERSALK9-M',
  iosVersion: '15.7(3)M5',
  image: 'c2900-universalk9-mz.SPA.157-3.M5.bin',
  sshEncryption: IOS_ENCRYPTION_ALGORITHMS,
  sshKex: [IOS_KEX_GROUP_EXCHANGE_SHA1, IOS_KEX_GROUP14_SHA1],
};

export const C3560_SOFTWARE: CiscoSoftwareIdentity = {
  softwareId: 'C3560-IPSERVICESK9-M',
  iosVersion: '12.2(55)SE12',
  image: 'c3560-ipservicesk9-mz.122-55.SE12.bin',
  sshEncryption: IOS_PRE_CTR_ENCRYPTION_ALGORITHMS,
  sshKex: [IOS_KEX_GROUP1_SHA1],
};

export interface CiscoSoftwareHolder {
  iosSoftware(): CiscoSoftwareIdentity;
}

export function ciscoSoftwareOf(device: object): CiscoSoftwareIdentity {
  return (device as Partial<CiscoSoftwareHolder>).iosSoftware?.() ?? C2900_SOFTWARE;
}

export function ciscoSoftwareDescriptor(
  sw: CiscoSoftwareIdentity,
  release?: string,
): string {
  const suffix = release ? `, ${release}` : '';
  const family = sw.softwareId.split('-')[0];
  return `Cisco IOS Software, ${family} Software (${sw.softwareId}), Version ${sw.iosVersion}${suffix}`;
}
