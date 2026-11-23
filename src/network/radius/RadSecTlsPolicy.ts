import type { TlsProtocolVersion } from '@/network/tls/legacy/legacyCipherSuites';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { slashDistinguishedName, splitDistinguishedName } from '@/network/pki/der/DistinguishedName';

export interface RadSecTlsLimits {
  readonly minVersion: string | null;
  readonly maxVersion: string | null;
  readonly checkCertIssuer: string | null;
  readonly checkCertCn: string | null;
}

export const NO_TLS_LIMITS: RadSecTlsLimits = { minVersion: null, maxVersion: null, checkCertIssuer: null, checkCertCn: null };

export const TLS_LIMIT_KEYS: readonly string[] = ['tls_min_version', 'tls_max_version', 'check_cert_issuer', 'check_cert_cn'];

const VERSIONS: readonly TlsProtocolVersion[] = ['1.0', '1.1', '1.2', '1.3'];

export function readTlsLimits(valueOf: (name: string) => string | undefined): RadSecTlsLimits {
  return {
    minVersion: valueOf('tls_min_version') ?? null, maxVersion: valueOf('tls_max_version') ?? null,
    checkCertIssuer: valueOf('check_cert_issuer') ?? null, checkCertCn: valueOf('check_cert_cn') ?? null,
  };
}

export function tlsLimitsError(limits: RadSecTlsLimits): string | null {
  if (limits.maxVersion !== null && limits.maxVersion !== '' && !VERSIONS.includes(limits.maxVersion as TlsProtocolVersion)) {
    return `Invalid value for tls_max_version '${limits.maxVersion}'`;
  }
  if (limits.minVersion !== null && limits.minVersion !== '' && !VERSIONS.includes(limits.minVersion as TlsProtocolVersion)) {
    return `Unknown or unsupported value for tls_min_version '${limits.minVersion}'`;
  }
  if (limits.checkCertCn !== null && limits.checkCertCn.includes('%')) {
    return 'The check_cert_cn value "' + limits.checkCertCn + '" is an expansion: a RadSec handshake has no request to expand it against in this simulator';
  }
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
