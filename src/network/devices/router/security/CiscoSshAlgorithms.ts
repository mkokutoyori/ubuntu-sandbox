import type { CiscoSoftwareIdentity } from '../../shells/cisco/CiscoPlatform';
import type { SshTransportPolicy } from '../../../protocols/ssh/server/ISshServerContext';
import type { SshConfig } from './CiscoSecurityConfig';
import type { SshClientProfile } from '../../../protocols/ssh/SshClientProfile';
import { IOS_SSH_CLIENT_IDENTIFICATION } from '../../../protocols/ssh/serverIdentification';

export type IosSshAlgorithmFamily = 'encryption' | 'mac' | 'hostkey' | 'kex';

export interface IosSshAlgorithms {
  readonly encryption: readonly string[];
  readonly mac: readonly string[];
  readonly hostkey: readonly string[];
  readonly kex: readonly string[];
}

export const IOS_ENCRYPTION_ALGORITHMS: readonly string[] = [
  'aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-cbc', '3des-cbc', 'aes192-cbc', 'aes256-cbc',
];

export const IOS_PRE_CTR_ENCRYPTION_ALGORITHMS: readonly string[] = [
  'aes128-cbc', '3des-cbc', 'aes192-cbc', 'aes256-cbc',
];

export const IOS_MAC_ALGORITHMS: readonly string[] = ['hmac-sha1', 'hmac-sha1-96'];

export const IOS_HOSTKEY_ALGORITHMS: readonly string[] = ['x509v3-ssh-rsa', 'ssh-rsa'];

export const IOS_KEX_GROUP_EXCHANGE_SHA1 = 'diffie-hellman-group-exchange-sha1';
export const IOS_KEX_GROUP14_SHA1 = 'diffie-hellman-group14-sha1';
export const IOS_KEX_GROUP1_SHA1 = 'diffie-hellman-group1-sha1';

export const IOS_KEX_ALGORITHMS: readonly string[] = [
  IOS_KEX_GROUP_EXCHANGE_SHA1, IOS_KEX_GROUP14_SHA1, IOS_KEX_GROUP1_SHA1,
];

export const IOS_ALGORITHM_VALUES: Readonly<Record<IosSshAlgorithmFamily, readonly string[]>> = {
  encryption: IOS_ENCRYPTION_ALGORITHMS,
  mac: [...IOS_MAC_ALGORITHMS, 'hmac-sha2-256', 'hmac-sha2-512'],
  hostkey: IOS_HOSTKEY_ALGORITHMS,
  kex: IOS_KEX_ALGORITHMS,
};

const X509_HOSTKEY = 'x509v3-ssh-rsa';

export function iosSshDefaults(software: CiscoSoftwareIdentity): IosSshAlgorithms {
  return {
    encryption: software.sshEncryption,
    mac: IOS_MAC_ALGORITHMS,
    hostkey: IOS_HOSTKEY_ALGORITHMS,
    kex: software.sshKex,
  };
}

export function effectiveIosSshAlgorithms(config: SshConfig, software: CiscoSoftwareIdentity): IosSshAlgorithms {
  const defaults = iosSshDefaults(software);
  const pick = (configured: readonly string[], fallback: readonly string[]): readonly string[] =>
    configured.length > 0 ? configured : fallback;
  return {
    encryption: pick(config.encryptionAlgorithms, defaults.encryption),
    mac: pick(config.macAlgorithms, defaults.mac),
    hostkey: pick(config.hostKeyAlgorithms, defaults.hostkey),
    kex: pick(config.kexAlgorithms, defaults.kex),
  };
}

export function iosSshTransportPolicy(config: SshConfig, software: CiscoSoftwareIdentity): SshTransportPolicy {
  const effective = effectiveIosSshAlgorithms(config, software);
  return {
    algorithms: {
      kex: effective.kex,
      hostKey: effective.hostkey.filter((name) => name !== X509_HOSTKEY),
      ciphers: effective.encryption,
      macs: effective.mac,
    },
    groupExchangeMinBits: config.dhMinBits,
    extInfo: false,
  };
}

export const IOS_CLIENT_HOSTKEY_ALGORITHMS: readonly string[] = ['ssh-rsa'];

export function iosSshClientProfile(config: SshConfig, software: CiscoSoftwareIdentity): SshClientProfile {
  const defaults = iosSshDefaults(software);
  return {
    identification: IOS_SSH_CLIENT_IDENTIFICATION,
    extInfo: false,
    algorithms: {
      kex: defaults.kex,
      hostKey: IOS_CLIENT_HOSTKEY_ALGORITHMS,
      ciphers: config.clientEncryptionAlgorithms.length > 0 ? config.clientEncryptionAlgorithms : defaults.encryption,
      macs: config.clientMacAlgorithms.length > 0 ? config.clientMacAlgorithms : defaults.mac,
    },
  };
}
