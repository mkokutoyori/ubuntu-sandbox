import type { TlsProtocolVersion } from '@/network/tls/legacy/legacyCipherSuites';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { pemToCertChain, pemToCrls } from '@/network/pki/pem';
import type { CertificateVerifierOptions } from '@/network/pki/CertificateVerifier';
import { resolveCipherList } from '@/network/tls/legacy/legacyCipherSuites';
import { parseTls13Ciphersuites } from '@/network/tls/cipherSuites';
import { slashDistinguishedName, splitDistinguishedName } from '@/network/pki/der/DistinguishedName';

export interface RadSecTlsLimits {
  readonly minVersion: string | null;
  readonly maxVersion: string | null;
  readonly checkCertIssuer: string | null;
  readonly checkCertCn: string | null;
  readonly checkCrl: boolean;
  readonly allowExpiredCrl: boolean;
  readonly checkAllCrl: boolean;
  readonly verifyDepth: number;
  readonly cipherList: string | null;
  readonly cipherSuites: string | null;
  readonly invalidBoolean?: { readonly name: string; readonly value: string };
}

export interface RadSecOcsp {
  readonly url: string | null;
  readonly overrideCertUrl: boolean;
  readonly useNonce: boolean;
  readonly timeoutSeconds: number;
  readonly softfail: boolean;
}

export interface RadSecTls {
  readonly certificateFile: string;
  readonly privateKeyFile: string;
  readonly privateKeyPassword: string | null;
  readonly caFile: string | null;
  readonly caPath?: string;
  readonly requireClientCert: boolean;
  readonly limits: RadSecTlsLimits;
  readonly ocsp?: RadSecOcsp;
}

export const NO_TLS_LIMITS: RadSecTlsLimits = { minVersion: null, maxVersion: null, checkCertIssuer: null, checkCertCn: null, checkCrl: false, allowExpiredCrl: false, checkAllCrl: false, verifyDepth: 0, cipherList: null, cipherSuites: null };

export const TLS_LIMIT_KEYS: readonly string[] = ['tls_min_version', 'tls_max_version', 'check_cert_issuer', 'check_cert_cn', 'check_crl', 'allow_expired_crl', 'check_all_crl', 'verify_depth', 'cipher_list', 'cipher_suites'];

const VERSIONS: readonly TlsProtocolVersion[] = ['1.0', '1.1', '1.2', '1.3'];

const BOOLEAN_WORD = /^(yes|no|true|false|on|off)$/i;

export function readTlsLimits(valueOf: (name: string) => string | undefined): RadSecTlsLimits {
  const bad = ['check_crl', 'allow_expired_crl', 'check_all_crl'].find((name) => valueOf(name) !== undefined && !BOOLEAN_WORD.test(valueOf(name)!));
  return {
    ...(bad === undefined ? {} : { invalidBoolean: { name: bad, value: valueOf(bad)! } }),
    minVersion: valueOf('tls_min_version') ?? null, maxVersion: valueOf('tls_max_version') ?? null,
    checkCertIssuer: valueOf('check_cert_issuer') ?? null, checkCertCn: valueOf('check_cert_cn') ?? null,
    checkCrl: /^(yes|true|on)$/i.test(valueOf('check_crl') ?? 'no'), allowExpiredCrl: /^(yes|true|on)$/i.test(valueOf('allow_expired_crl') ?? 'no'),
    checkAllCrl: /^(yes|true|on)$/i.test(valueOf('check_all_crl') ?? 'no'), verifyDepth: /^\d+$/.test(valueOf('verify_depth') ?? '0') ? Number(valueOf('verify_depth') ?? '0') : -1,
    cipherList: valueOf('cipher_list') ?? null, cipherSuites: valueOf('cipher_suites') ?? null,
  };
}

export function tlsLimitsError(limits: RadSecTlsLimits): string | null {
  if (limits.invalidBoolean !== undefined) return `Invalid value "${limits.invalidBoolean.value}" for variable ${limits.invalidBoolean.name}`;
  if (limits.maxVersion !== null && limits.maxVersion !== '' && !VERSIONS.includes(limits.maxVersion as TlsProtocolVersion)) {
    return `Invalid value for tls_max_version '${limits.maxVersion}'`;
  }
  if (limits.minVersion !== null && limits.minVersion !== '' && !VERSIONS.includes(limits.minVersion as TlsProtocolVersion)) {
    return `Unknown or unsupported value for tls_min_version '${limits.minVersion}'`;
  }
  if (limits.checkCertCn !== null && limits.checkCertCn.includes('%')) {
    return 'The check_cert_cn value "' + limits.checkCertCn + '" is an expansion: a RadSec handshake has no request to expand it against in this simulator';
  }
  if (limits.verifyDepth < 0) return 'Invalid value for variable verify_depth';
  if (limits.cipherList !== null && limits.cipherList !== '' && resolveCipherList(limits.cipherList).ok === false) return 'Failed setting cipher_list';
  if (limits.cipherSuites !== null && limits.cipherSuites !== '' && parseTls13Ciphersuites(limits.cipherSuites).length === 0) return 'Failed setting cipher_suites';
  const { low, high } = versionBounds(limits);
  if (low > high) return `tls_min_version '${limits.minVersion ?? ''}' must be <= tls_max_version '${limits.maxVersion ?? ''}'`;
  return null;
}

function versionBounds(limits: RadSecTlsLimits): { low: number; high: number } {
  const high = limits.maxVersion !== null && limits.maxVersion !== '' ? VERSIONS.indexOf(limits.maxVersion as TlsProtocolVersion) : VERSIONS.indexOf('1.2');
  const low = limits.minVersion !== null && limits.minVersion !== '' ? VERSIONS.indexOf(limits.minVersion as TlsProtocolVersion) : VERSIONS.indexOf('1.0');
  return { low, high };
}

export function tlsProtocolsOf(limits: RadSecTlsLimits): TlsProtocolVersion[] {
  const { low, high } = versionBounds(limits);
  return VERSIONS.filter((_version, index) => index >= low && index <= high).reverse();
}

export function certificateRejection(certificate: X509Certificate | null, limits: RadSecTlsLimits): string | null {
  if (certificate === null) return null;
  if (limits.checkCertIssuer !== null && slashDistinguishedName(certificate.issuer) !== limits.checkCertIssuer) {
    return `Certificate issuer (${slashDistinguishedName(certificate.issuer)}) does not match specified value (${limits.checkCertIssuer})!`;
  }
  if (limits.checkCertCn !== null) {
    const commonName = splitDistinguishedName(certificate.subject).find((attribute) => attribute.type.toLowerCase() === 'cn')?.value ?? '';
    if (commonName !== limits.checkCertCn) return `Certificate CN (${commonName}) does not match specified value (${limits.checkCertCn})!`;
  }
  return null;
}

export function verifierOptions(caText: string | null, limits: Pick<RadSecTlsLimits, 'checkCrl' | 'allowExpiredCrl'> & Partial<Pick<RadSecTlsLimits, 'checkAllCrl' | 'verifyDepth'>>, clock: () => number): CertificateVerifierOptions {
  const text = caText ?? '';
  return {
    trustAnchors: pemToCertChain(text), clock,
    ...(limits.verifyDepth !== undefined && limits.verifyDepth > 0 ? { maxDepth: limits.verifyDepth + 1 } : {}),
    ...(limits.checkCrl ? { crls: pemToCrls(text), revocationCheck: 'crl-strict' as const, revocationScope: limits.checkAllCrl === true ? 'chain' as const : 'leaf' as const, allowStaleCrl: limits.allowExpiredCrl } : {}),
  };
}

export function cipherOptions(limits: Pick<RadSecTlsLimits, 'cipherList' | 'cipherSuites'>): { cipherList?: string; tls13Ciphersuites?: string } {
  return {
    ...(limits.cipherList === null || limits.cipherList === '' ? {} : { cipherList: limits.cipherList }),
    ...(limits.cipherSuites === null || limits.cipherSuites === '' ? {} : { tls13Ciphersuites: limits.cipherSuites }),
  };
}
