import type { CipherSuite } from '../types';

export const GREASE_CIPHER_SUITE_NAME = 'TLS_GREASE_0A0A';

const CIPHER_SUITE_CODES: Readonly<Record<string, number>> = {
  TLS_AES_128_GCM_SHA256: 0x1301,
  TLS_AES_256_GCM_SHA384: 0x1302,
  TLS_CHACHA20_POLY1305_SHA256: 0x1303,
  TLS_AES_128_CCM_SHA256: 0x1304,
  TLS_AES_128_CCM_8_SHA256: 0x1305,
};

const NAMED_GROUP_CODES: Readonly<Record<string, number>> = {
  secp256r1: 0x0017,
  secp384r1: 0x0018,
  secp521r1: 0x0019,
  x25519: 0x001d,
  x448: 0x001e,
  ffdhe2048: 0x0100,
  ffdhe3072: 0x0101,
  ffdhe4096: 0x0102,
  ffdhe6144: 0x0103,
  ffdhe8192: 0x0104,
};

const SIGNATURE_SCHEME_CODES: Readonly<Record<string, number>> = {
  rsa_pkcs1_sha1: 0x0201,
  ecdsa_sha1: 0x0203,
  rsa_pkcs1_sha256: 0x0401,
  ecdsa_secp256r1_sha256: 0x0403,
  rsa_pkcs1_sha384: 0x0501,
  ecdsa_secp384r1_sha384: 0x0503,
  rsa_pkcs1_sha512: 0x0601,
  ecdsa_secp521r1_sha512: 0x0603,
  rsa_pss_rsae_sha256: 0x0804,
  rsa_pss_rsae_sha384: 0x0805,
  rsa_pss_rsae_sha512: 0x0806,
  ed25519: 0x0807,
  ed448: 0x0808,
  rsa_pss_pss_sha256: 0x0809,
  rsa_pss_pss_sha384: 0x080a,
  rsa_pss_pss_sha512: 0x080b,
};

const VERSION_CODES: Readonly<Record<string, number>> = {
  '1.0': 0x0301,
  '1.1': 0x0302,
  '1.2': 0x0303,
  '1.3': 0x0304,
};

export const EXTENSION = {
  serverName: 0,
  maxFragmentLength: 1,
  statusRequest: 5,
  supportedGroups: 10,
  ecPointFormats: 11,
  signatureAlgorithms: 13,
  alpn: 16,
  extendedMasterSecret: 23,
  sessionTicket: 35,
  preSharedKey: 41,
  earlyData: 42,
  supportedVersions: 43,
  pskKeyExchangeModes: 45,
  keyShare: 51,
  renegotiationInfo: 0xff01,
} as const;

export const HANDSHAKE_TYPE = {
  clientHello: 1,
  serverHello: 2,
  newSessionTicket: 4,
  encryptedExtensions: 8,
  certificate: 11,
  serverKeyExchange: 12,
  certificateRequest: 13,
  serverHelloDone: 14,
  certificateVerify: 15,
  clientKeyExchange: 16,
  finished: 20,
  certificateStatus: 22,
  keyUpdate: 24,
} as const;

const PSK_MODE_CODES: Readonly<Record<string, number>> = { psk_ke: 0, psk_dhe_ke: 1 };

export function isGreaseCode(code: number): boolean {
  return (code & 0x0f0f) === 0x0a0a && (code >> 8) === (code & 0xff);
}

function hex4(code: number): string {
  return code.toString(16).padStart(4, '0');
}

function codeOf(table: Readonly<Record<string, number>>, name: string, greasePrefix: string, unknownPrefix: string): number {
  if (table[name] !== undefined) return table[name];
  const grease = new RegExp(`^${greasePrefix}_([0-9a-f]{4})$`).exec(name);
  if (grease) return parseInt(grease[1], 16);
  const unknown = new RegExp(`^${unknownPrefix}_([0-9a-f]{4})$`).exec(name);
  if (unknown) return parseInt(unknown[1], 16);
  throw new Error(`no wire code for "${name}"`);
}

function nameOf(table: Readonly<Record<string, number>>, code: number, greasePrefix: string, unknownPrefix: string): string {
  const known = Object.entries(table).find(([, value]) => value === code);
  if (known) return known[0];
  return isGreaseCode(code) ? `${greasePrefix}_${hex4(code)}` : `${unknownPrefix}_${hex4(code)}`;
}

export function cipherSuiteCode(name: string): number {
  if (name === GREASE_CIPHER_SUITE_NAME) return 0x0a0a;
  return codeOf(CIPHER_SUITE_CODES, name, 'grease', 'suite');
}

export function cipherSuiteName(code: number): string {
  if (code === 0x0a0a) return GREASE_CIPHER_SUITE_NAME;
  return nameOf(CIPHER_SUITE_CODES, code, 'grease', 'suite');
}

export function isTls13CipherSuiteCode(code: number): boolean {
  return Object.values(CIPHER_SUITE_CODES).includes(code);
}

export const groupCode = (name: string): number => codeOf(NAMED_GROUP_CODES, name, 'grease', 'group');
export const groupName = (code: number): string => nameOf(NAMED_GROUP_CODES, code, 'grease', 'group');
export const signatureSchemeCode = (name: string): number => codeOf(SIGNATURE_SCHEME_CODES, name, 'grease', 'sigalg');
export const signatureSchemeName = (code: number): string => nameOf(SIGNATURE_SCHEME_CODES, code, 'grease', 'sigalg');
export const versionCode = (name: string): number => codeOf(VERSION_CODES, name, 'grease', 'version');
export const versionName = (code: number): string => nameOf(VERSION_CODES, code, 'grease', 'version');
export const pskModeCode = (name: string): number => codeOf(PSK_MODE_CODES, name, 'grease', 'mode');
export const pskModeName = (code: number): string => nameOf(PSK_MODE_CODES, code, 'grease', 'mode');

export const cipherSuiteFromCode = (code: number): CipherSuite => cipherSuiteName(code) as CipherSuite;

const MAX_FRAGMENT_LENGTH_CODES: Readonly<Record<number, number>> = { 512: 1, 1024: 2, 2048: 3, 4096: 4 };

export function maxFragmentLengthCode(bytes: number): number {
  const code = MAX_FRAGMENT_LENGTH_CODES[bytes];
  if (code === undefined) throw new Error(`no max_fragment_length code for ${bytes}`);
  return code;
}

export function maxFragmentLengthBytes(code: number): number {
  const found = Object.entries(MAX_FRAGMENT_LENGTH_CODES).find(([, value]) => value === code);
  if (!found) throw new Error(`unknown max_fragment_length code ${code}`);
  return Number(found[0]);
}
