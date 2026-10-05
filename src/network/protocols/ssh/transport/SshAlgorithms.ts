import { CIPHER_SPECS, MAC_SPECS, cipherSpec } from './SshBinaryPacket';
import { KEX_METHODS } from './SshKeyExchange';

export const OPENSSH_KEX_ALGORITHMS: readonly string[] = [
  'curve25519-sha256',
  'curve25519-sha256@libssh.org',
  'ecdh-sha2-nistp256',
  'ecdh-sha2-nistp384',
  'ecdh-sha2-nistp521',
  'sntrup761x25519-sha512@openssh.com',
  'diffie-hellman-group-exchange-sha256',
  'diffie-hellman-group16-sha512',
  'diffie-hellman-group18-sha512',
  'diffie-hellman-group14-sha256',
];

export const OPENSSH_HOST_KEY_ALGORITHMS: readonly string[] = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
  'rsa-sha2-512',
  'rsa-sha2-256',
];

export const OPENSSH_CIPHERS: readonly string[] = [
  'chacha20-poly1305@openssh.com',
  'aes128-ctr',
  'aes192-ctr',
  'aes256-ctr',
  'aes128-gcm@openssh.com',
  'aes256-gcm@openssh.com',
];

export const OPENSSH_MACS: readonly string[] = [
  'umac-64-etm@openssh.com',
  'umac-128-etm@openssh.com',
  'hmac-sha2-256-etm@openssh.com',
  'hmac-sha2-512-etm@openssh.com',
  'hmac-sha1-etm@openssh.com',
  'umac-64@openssh.com',
  'umac-128@openssh.com',
  'hmac-sha2-256',
  'hmac-sha2-512',
  'hmac-sha1',
];

export const OPENSSH_COMPRESSION: readonly string[] = ['none', 'zlib@openssh.com'];

export const EXT_INFO_CLIENT = 'ext-info-c';

export const IMPLEMENTED_KEX_METHODS: readonly string[] = KEX_METHODS.map((m) => m.name);
export const IMPLEMENTED_HOST_KEY_ALGORITHMS: readonly string[] = [
  'ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-512', 'rsa-sha2-256',
];
export const IMPLEMENTED_CIPHERS: readonly string[] = CIPHER_SPECS.map((c) => c.name);
export const IMPLEMENTED_MACS: readonly string[] = MAC_SPECS.map((m) => m.name);
export const IMPLEMENTED_COMPRESSION: readonly string[] = ['none'];

export const SERVER_SIGNATURE_ALGORITHMS: readonly string[] = [
  'ssh-ed25519', 'rsa-sha2-256', 'rsa-sha2-512', 'ecdsa-sha2-nistp256',
];

export function implementedOnly(names: readonly string[], implemented: readonly string[]): string[] {
  return names.filter((name) => implemented.includes(name));
}

export function isAeadCipher(name: string): boolean {
  return (cipherSpec(name)?.authLength ?? 0) > 0;
}
