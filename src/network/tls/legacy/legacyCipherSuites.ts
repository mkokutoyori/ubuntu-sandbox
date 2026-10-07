import { DEFAULT_SECURITY_LEVEL, cipherPermitted, versionPermitted } from './securityPolicy';
import { TLS13_SUITES } from '../suite13';
import { createCipherList, ALL_CIPHERS, type OpensslCipher } from './cipherString';

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
export type BulkCipher =
  | 'AES_128_GCM' | 'AES_256_GCM' | 'AES_128_CBC' | 'AES_256_CBC' | '3DES_EDE_CBC'
  | 'AES_128_CCM' | 'AES_256_CCM' | 'AES_128_CCM_8' | 'AES_256_CCM_8' | 'CHACHA20_POLY1305'
  | 'CAMELLIA_128_CBC' | 'CAMELLIA_256_CBC' | 'ARIA_128_GCM' | 'ARIA_256_GCM';
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
  readonly strengthBits: number;
  readonly cipherEntry: OpensslCipher;
}

const BULK: Readonly<Record<string, BulkCipher>> = {
  '3DES': '3DES_EDE_CBC', AES128: 'AES_128_CBC', AES256: 'AES_256_CBC', AES128GCM: 'AES_128_GCM',
  AES256GCM: 'AES_256_GCM', AES128CCM: 'AES_128_CCM', AES256CCM: 'AES_256_CCM',
  AES128CCM8: 'AES_128_CCM_8', AES256CCM8: 'AES_256_CCM_8', CHACHA20: 'CHACHA20_POLY1305',
  CAMELLIA128: 'CAMELLIA_128_CBC', CAMELLIA256: 'CAMELLIA_256_CBC', ARIA128GCM: 'ARIA_128_GCM', ARIA256GCM: 'ARIA_256_GCM',
};

function toDefinition(cipher: OpensslCipher): LegacySuiteDefinition {
  const entry = cipher.entry;
  const keyExchange: KeyExchangeKind = entry.mkey === 'RSA' ? 'RSA'
    : entry.mkey === 'DHE' ? 'DHE_RSA'
      : entry.auth === 'ECDSA' ? 'ECDHE_ECDSA' : 'ECDHE_RSA';
  return {
    name: entry.standard, opensslName: entry.openssl, code: entry.code, keyExchange,
    cipher: BULK[entry.enc], mac: entry.mac,
    prf: entry.prf === 'SHA384' ? 'SHA384' : 'SHA256',
    minVersion: entry.minTls === 'TLS1_2' ? '1.2' : '1.0',
    strengthBits: entry.strengthBits, cipherEntry: cipher,
  };
}

export const LEGACY_CIPHER_SUITES: readonly LegacySuiteDefinition[] = ALL_CIPHERS.map(toDefinition);

const BY_NAME = new Map(LEGACY_CIPHER_SUITES.map((definition) => [definition.name, definition]));
const BY_OPENSSL = new Map(LEGACY_CIPHER_SUITES.map((definition) => [definition.opensslName, definition]));
const BY_CODE = new Map(LEGACY_CIPHER_SUITES.map((definition) => [definition.code, definition]));

export function legacySuiteByName(name: string): LegacySuiteDefinition | undefined {
  return BY_NAME.get(name);
}

export function legacySuiteByOpensslName(name: string): LegacySuiteDefinition | undefined {
  return BY_OPENSSL.get(name);
}

export function legacySuiteByCode(code: number): LegacySuiteDefinition | undefined {
  return BY_CODE.get(code);
}

const IMPLEMENTED_BULK: ReadonlySet<BulkCipher> = new Set<BulkCipher>([
  'AES_128_GCM', 'AES_256_GCM', 'AES_128_CBC', 'AES_256_CBC', '3DES_EDE_CBC',
  'AES_128_CCM', 'AES_256_CCM', 'AES_128_CCM_8', 'AES_256_CCM_8', 'CHACHA20_POLY1305',
  'CAMELLIA_128_CBC', 'CAMELLIA_256_CBC', 'ARIA_128_GCM', 'ARIA_256_GCM',
]);

export function isImplementedLegacySuite(definition: LegacySuiteDefinition): boolean {
  return IMPLEMENTED_BULK.has(definition.cipher);
}

export function isImplementedCipher(cipher: OpensslCipher): boolean {
  const definition = BY_OPENSSL.get(cipher.name);
  return definition !== undefined && isImplementedLegacySuite(definition);
}

export function isImplementedTls13Cipher(cipher: { readonly name: string }): boolean {
  return suiteInfoByName(cipher.name);
}

export function suiteUsableAt(definition: LegacySuiteDefinition, version: LegacyVersion): boolean {
  const order: readonly LegacyVersion[] = ['1.0', '1.1', '1.2'];
  return order.indexOf(version) >= order.indexOf(definition.minVersion);
}

export function isForwardSecret(definition: LegacySuiteDefinition): boolean {
  return definition.keyExchange !== 'RSA';
}

export interface ResolvedCipherPolicy {
  readonly suites: readonly LegacySuiteDefinition[];
  readonly securityLevel: number | null;
}

export type CipherPolicyResult =
  | ({ readonly ok: true } & ResolvedCipherPolicy)
  | { readonly ok: false; readonly error: string };

export function resolveCipherList(ruleString: string): CipherPolicyResult {
  const list = createCipherList(ruleString, { isAvailable: isImplementedCipher });
  if (list.ok === false) return { ok: false, error: list.error };
  return {
    ok: true, securityLevel: list.securityLevel,
    suites: list.ciphers.map((cipher) => BY_OPENSSL.get(cipher.name)!),
  };
}

const DEFAULT_RESOLVED = resolveCipherList('DEFAULT');

export const DEFAULT_LEGACY_CLIENT_SUITES: readonly string[] =
  DEFAULT_RESOLVED.ok ? DEFAULT_RESOLVED.suites.map((suite) => suite.name) : [];

export const DEFAULT_LEGACY_SERVER_SUITES: readonly string[] = DEFAULT_LEGACY_CLIENT_SUITES;

export interface TlsPolicyConfig {
  readonly cipherList?: string;
  readonly legacyCipherSuites?: readonly string[];
  readonly securityLevel?: number;
}

export interface ResolvedLegacyPolicy {
  readonly suites: readonly LegacySuiteDefinition[];
  readonly securityLevel: number;
  readonly error: string | null;
}

export function resolveLegacyPolicy(config: TlsPolicyConfig): ResolvedLegacyPolicy {
  const baseLevel = config.securityLevel ?? DEFAULT_SECURITY_LEVEL;
  if (config.legacyCipherSuites) {
    const suites = config.legacyCipherSuites
      .map((name) => BY_NAME.get(name))
      .filter((definition): definition is LegacySuiteDefinition => definition !== undefined && isImplementedLegacySuite(definition))
      .filter((definition) => cipherPermitted(baseLevel, definition));
    return { suites, securityLevel: baseLevel, error: null };
  }
  const resolved = resolveCipherList(config.cipherList ?? 'DEFAULT');
  if (resolved.ok === false) return { suites: [], securityLevel: baseLevel, error: resolved.error };
  const level = resolved.securityLevel ?? baseLevel;
  return {
    suites: resolved.suites.filter((definition) => cipherPermitted(level, definition)),
    securityLevel: level, error: null,
  };
}

export function permittedVersions(versions: readonly TlsProtocolVersion[], level: number): TlsProtocolVersion[] {
  return versions.filter((version) => versionPermitted(level, version));
}

function suiteInfoByName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TLS13_SUITES, name);
}
