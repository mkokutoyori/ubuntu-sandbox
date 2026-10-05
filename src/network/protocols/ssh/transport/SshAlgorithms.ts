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
  'ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa',
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

function wildcardMatcher(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

export function assembleAlgorithmList(defaults: readonly string[], spec: string): string[] {
  const names = spec.split(',').filter((name) => name !== '');
  const mode = spec[0];
  if (mode === '+') {
    const added = spec.slice(1).split(',').filter((name) => name !== '');
    return [...defaults, ...added.filter((name) => !defaults.includes(name))];
  }
  if (mode === '-') {
    const patterns = spec.slice(1).split(',').filter((name) => name !== '').map(wildcardMatcher);
    return defaults.filter((name) => !patterns.some((pattern) => pattern.test(name)));
  }
  if (mode === '^') {
    const first = spec.slice(1).split(',').filter((name) => name !== '');
    return [...first, ...defaults.filter((name) => !first.includes(name))];
  }
  return names;
}

export interface SshAlgorithmDirectives {
  readonly kex?: string;
  readonly hostKey?: string;
  readonly ciphers?: string;
  readonly macs?: string;
}

export interface SshAlgorithmDefaults {
  readonly kex: readonly string[];
  readonly hostKey: readonly string[];
  readonly ciphers: readonly string[];
  readonly macs: readonly string[];
}

export const OPENSSH_ALGORITHM_DEFAULTS: SshAlgorithmDefaults = {
  kex: OPENSSH_KEX_ALGORITHMS,
  hostKey: OPENSSH_HOST_KEY_ALGORITHMS,
  ciphers: OPENSSH_CIPHERS,
  macs: OPENSSH_MACS,
};

export function resolveAlgorithmDirectives(
  directives: SshAlgorithmDirectives, defaults: SshAlgorithmDefaults = OPENSSH_ALGORITHM_DEFAULTS,
): { kex?: string[]; hostKey?: string[]; ciphers?: string[]; macs?: string[] } {
  return {
    ...(directives.kex === undefined ? {} : { kex: assembleAlgorithmList(defaults.kex, directives.kex) }),
    ...(directives.hostKey === undefined ? {} : { hostKey: assembleAlgorithmList(defaults.hostKey, directives.hostKey) }),
    ...(directives.ciphers === undefined ? {} : { ciphers: assembleAlgorithmList(defaults.ciphers, directives.ciphers) }),
    ...(directives.macs === undefined ? {} : { macs: assembleAlgorithmList(defaults.macs, directives.macs) }),
  };
}

const KNOWN_CIPHERS: readonly string[] = [
  '3des-cbc', 'aes128-cbc', 'aes192-cbc', 'aes256-cbc', 'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
  'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com', 'chacha20-poly1305@openssh.com', 'none',
];

const KNOWN_MAC_BASES: readonly string[] = [
  'hmac-sha1', 'hmac-sha1-96', 'hmac-sha2-256', 'hmac-sha2-512', 'hmac-md5', 'hmac-md5-96',
  'umac-64@openssh.com', 'umac-128@openssh.com',
];

const KNOWN_MACS: readonly string[] = [
  ...KNOWN_MAC_BASES,
  ...KNOWN_MAC_BASES.filter((name) => !name.includes('@')).map((name) => `${name}-etm@openssh.com`),
  'umac-64-etm@openssh.com', 'umac-128-etm@openssh.com',
];

const KNOWN_KEX: readonly string[] = [
  'diffie-hellman-group1-sha1', 'diffie-hellman-group14-sha1', 'diffie-hellman-group14-sha256',
  'diffie-hellman-group16-sha512', 'diffie-hellman-group18-sha512', 'diffie-hellman-group-exchange-sha1',
  'diffie-hellman-group-exchange-sha256', 'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
  'curve25519-sha256', 'curve25519-sha256@libssh.org', 'sntrup761x25519-sha512@openssh.com',
];

const PLAIN_KEY_TYPES: readonly string[] = [
  'ssh-ed25519', 'sk-ssh-ed25519@openssh.com', 'ssh-rsa', 'rsa-sha2-256', 'rsa-sha2-512', 'ssh-dss',
  'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'sk-ecdsa-sha2-nistp256@openssh.com',
];

const KNOWN_KEY_TYPES: readonly string[] = [
  ...PLAIN_KEY_TYPES,
  ...PLAIN_KEY_TYPES.map((name) => `${name.replace('@openssh.com', '')}-cert-v01@openssh.com`),
];

export type AlgorithmKeyword = 'ciphers' | 'macs' | 'kexalgorithms' | 'hostkeyalgorithms';

const KNOWN_BY_KEYWORD: Readonly<Record<AlgorithmKeyword, readonly string[]>> = {
  ciphers: KNOWN_CIPHERS,
  macs: KNOWN_MACS,
  kexalgorithms: KNOWN_KEX,
  hostkeyalgorithms: KNOWN_KEY_TYPES,
};

const DEFAULTS_BY_KEYWORD: Readonly<Record<AlgorithmKeyword, readonly string[]>> = {
  ciphers: OPENSSH_CIPHERS,
  macs: OPENSSH_MACS,
  kexalgorithms: OPENSSH_KEX_ALGORITHMS,
  hostkeyalgorithms: OPENSSH_HOST_KEY_ALGORITHMS,
};

export function algorithmKeyword(name: string): AlgorithmKeyword | null {
  const lowered = name.toLowerCase();
  return lowered in KNOWN_BY_KEYWORD ? lowered as AlgorithmKeyword : null;
}

export function algorithmDirectiveIsValid(keyword: AlgorithmKeyword, spec: string): boolean {
  const named = spec.replace(/^[+\-^]/, '').split(',').filter((name) => name !== '');
  if (spec[0] !== '-' && !named.every((name) => KNOWN_BY_KEYWORD[keyword].includes(name))) return false;
  return assembleAlgorithmList(DEFAULTS_BY_KEYWORD[keyword], spec).length > 0;
}
