export type LegacyVersion = '1.0' | '1.1' | '1.2';
export type TlsProtocolVersion = LegacyVersion | '1.3';

export const PROTOCOL_VERSION_WIRE: Record<TlsProtocolVersion, number> = {
  '1.0': 0x0301,
  '1.1': 0x0302,
  '1.2': 0x0303,
  '1.3': 0x0304,
};

export const PROTOCOL_VERSIONS_BY_PREFERENCE: readonly TlsProtocolVersion[] = ['1.3', '1.2', '1.1', '1.0'];

export type KeyExchangeKind = 'ECDHE_RSA' | 'ECDHE_ECDSA' | 'DHE_RSA' | 'RSA';
export type BulkCipher = 'AES_128_GCM' | 'AES_256_GCM' | 'AES_128_CBC' | 'AES_256_CBC' | '3DES_EDE_CBC' | 'RC4_128';
export type MacHash = 'SHA1' | 'SHA256' | 'SHA384' | 'AEAD';
export type PrfHash = 'SHA256' | 'SHA384';

export interface LegacySuiteDefinition {
  readonly name: string;
  readonly opensslName: string;
  readonly code: number;
  readonly keyExchange: KeyExchangeKind;
  readonly cipher: BulkCipher;
  readonly mac: MacHash;
  readonly prf: PrfHash;
  readonly minVersion: LegacyVersion;
  readonly prohibitedBy?: string;
}

function suite(
  name: string, opensslName: string, code: number, keyExchange: KeyExchangeKind,
  cipher: BulkCipher, mac: MacHash, prf: PrfHash, minVersion: LegacyVersion, prohibitedBy?: string,
): LegacySuiteDefinition {
  return { name, opensslName, code, keyExchange, cipher, mac, prf, minVersion, prohibitedBy };
}

export const LEGACY_CIPHER_SUITES: readonly LegacySuiteDefinition[] = [
  suite('TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384', 'ECDHE-ECDSA-AES256-GCM-SHA384', 0xc02c, 'ECDHE_ECDSA', 'AES_256_GCM', 'AEAD', 'SHA384', '1.2'),
  suite('TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256', 'ECDHE-ECDSA-AES128-GCM-SHA256', 0xc02b, 'ECDHE_ECDSA', 'AES_128_GCM', 'AEAD', 'SHA256', '1.2'),
  suite('TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384', 'ECDHE-RSA-AES256-GCM-SHA384', 0xc030, 'ECDHE_RSA', 'AES_256_GCM', 'AEAD', 'SHA384', '1.2'),
  suite('TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256', 'ECDHE-RSA-AES128-GCM-SHA256', 0xc02f, 'ECDHE_RSA', 'AES_128_GCM', 'AEAD', 'SHA256', '1.2'),
  suite('TLS_DHE_RSA_WITH_AES_256_GCM_SHA384', 'DHE-RSA-AES256-GCM-SHA384', 0x009f, 'DHE_RSA', 'AES_256_GCM', 'AEAD', 'SHA384', '1.2'),
  suite('TLS_DHE_RSA_WITH_AES_128_GCM_SHA256', 'DHE-RSA-AES128-GCM-SHA256', 0x009e, 'DHE_RSA', 'AES_128_GCM', 'AEAD', 'SHA256', '1.2'),
  suite('TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA', 'ECDHE-ECDSA-AES256-SHA', 0xc00a, 'ECDHE_ECDSA', 'AES_256_CBC', 'SHA1', 'SHA256', '1.2'),
  suite('TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA', 'ECDHE-ECDSA-AES128-SHA', 0xc009, 'ECDHE_ECDSA', 'AES_128_CBC', 'SHA1', 'SHA256', '1.2'),
  suite('TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA384', 'ECDHE-RSA-AES256-SHA384', 0xc028, 'ECDHE_RSA', 'AES_256_CBC', 'SHA384', 'SHA384', '1.2'),
  suite('TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256', 'ECDHE-RSA-AES128-SHA256', 0xc027, 'ECDHE_RSA', 'AES_128_CBC', 'SHA256', 'SHA256', '1.2'),
  suite('TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA', 'ECDHE-RSA-AES256-SHA', 0xc014, 'ECDHE_RSA', 'AES_256_CBC', 'SHA1', 'SHA256', '1.0'),
  suite('TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA', 'ECDHE-RSA-AES128-SHA', 0xc013, 'ECDHE_RSA', 'AES_128_CBC', 'SHA1', 'SHA256', '1.0'),
  suite('TLS_DHE_RSA_WITH_AES_256_CBC_SHA', 'DHE-RSA-AES256-SHA', 0x0039, 'DHE_RSA', 'AES_256_CBC', 'SHA1', 'SHA256', '1.0'),
  suite('TLS_DHE_RSA_WITH_AES_128_CBC_SHA', 'DHE-RSA-AES128-SHA', 0x0033, 'DHE_RSA', 'AES_128_CBC', 'SHA1', 'SHA256', '1.0'),
  suite('TLS_RSA_WITH_AES_256_GCM_SHA384', 'AES256-GCM-SHA384', 0x009d, 'RSA', 'AES_256_GCM', 'AEAD', 'SHA384', '1.2'),
  suite('TLS_RSA_WITH_AES_128_GCM_SHA256', 'AES128-GCM-SHA256', 0x009c, 'RSA', 'AES_128_GCM', 'AEAD', 'SHA256', '1.2'),
  suite('TLS_RSA_WITH_AES_256_CBC_SHA256', 'AES256-SHA256', 0x003d, 'RSA', 'AES_256_CBC', 'SHA256', 'SHA256', '1.2'),
  suite('TLS_RSA_WITH_AES_128_CBC_SHA256', 'AES128-SHA256', 0x003c, 'RSA', 'AES_128_CBC', 'SHA256', 'SHA256', '1.2'),
  suite('TLS_RSA_WITH_AES_256_CBC_SHA', 'AES256-SHA', 0x0035, 'RSA', 'AES_256_CBC', 'SHA1', 'SHA256', '1.0'),
  suite('TLS_RSA_WITH_AES_128_CBC_SHA', 'AES128-SHA', 0x002f, 'RSA', 'AES_128_CBC', 'SHA1', 'SHA256', '1.0'),
  suite('TLS_RSA_WITH_3DES_EDE_CBC_SHA', 'DES-CBC3-SHA', 0x000a, 'RSA', '3DES_EDE_CBC', 'SHA1', 'SHA256', '1.0'),
  suite('TLS_RSA_WITH_RC4_128_SHA', 'RC4-SHA', 0x0005, 'RSA', 'RC4_128', 'SHA1', 'SHA256', '1.0', 'RFC 7465'),
];

const BY_NAME = new Map(LEGACY_CIPHER_SUITES.map((definition) => [definition.name, definition]));
const BY_OPENSSL = new Map(LEGACY_CIPHER_SUITES.map((definition) => [definition.opensslName, definition]));

export function legacySuiteByName(name: string): LegacySuiteDefinition | undefined {
  return BY_NAME.get(name);
}

export function legacySuiteByOpensslName(name: string): LegacySuiteDefinition | undefined {
  return BY_OPENSSL.get(name);
}

export function isImplementedLegacySuite(definition: LegacySuiteDefinition): boolean {
  return definition.cipher !== 'RC4_128';
}

export function suiteUsableAt(definition: LegacySuiteDefinition, version: LegacyVersion): boolean {
  const order: readonly LegacyVersion[] = ['1.0', '1.1', '1.2'];
  return order.indexOf(version) >= order.indexOf(definition.minVersion);
}

export function isForwardSecret(definition: LegacySuiteDefinition): boolean {
  return definition.keyExchange !== 'RSA';
}

export const DEFAULT_LEGACY_CLIENT_SUITES: readonly string[] = LEGACY_CIPHER_SUITES
  .filter((definition) => isImplementedLegacySuite(definition) && definition.prohibitedBy === undefined)
  .filter((definition) => definition.cipher !== '3DES_EDE_CBC')
  .map((definition) => definition.name);

export const DEFAULT_LEGACY_SERVER_SUITES: readonly string[] = DEFAULT_LEGACY_CLIENT_SUITES;
