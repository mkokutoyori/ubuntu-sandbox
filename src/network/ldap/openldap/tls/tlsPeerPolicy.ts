import { sha1, sha224, sha256, sha384, sha512, md5 } from '@/crypto/hash';
import { sha3 } from '@/crypto/hash/sha3';
import { inetAton } from '@/network/core/InetAton';
import { IPAddress, IPv6Address } from '@/network/core/types';
import type { VerificationReason } from '@/network/pki/CertificateVerifier';
import { splitDistinguishedName } from '@/network/pki/der/DistinguishedName';
import { encodeSubjectPublicKeyInfo } from '@/network/pki/der/X509Der';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { LdapRc } from '../ldapErrors';
import { LdapDebug } from '../ldapLog';
import { TlsRequireCert, type LdapOptions } from '../ldapOptions';

export interface TraceLine {
  readonly level: number;
  readonly text: string;
}

export type PeerVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly errno: number | null; readonly lines: readonly TraceLine[] };

export type ChainVerification = { readonly ok: true } | { readonly ok: false; readonly reason: VerificationReason };

const GNUTLS_CERT_INVALID = 0x2;
const GNUTLS_CERT_REVOKED = 0x20;
const GNUTLS_CERT_SIGNER_NOT_FOUND = 0x40;
const GNUTLS_CERT_SIGNER_NOT_CA = 0x80;
const GNUTLS_CERT_NOT_ACTIVATED = 0x200;
const GNUTLS_CERT_EXPIRED = 0x400;
const GNUTLS_CERT_SIGNATURE_FAILURE = 0x800;

const STATUS_OF_REASON: Readonly<Partial<Record<VerificationReason, number>>> = {
  unknown: GNUTLS_CERT_INVALID | GNUTLS_CERT_SIGNER_NOT_FOUND,
  expired: GNUTLS_CERT_INVALID | GNUTLS_CERT_EXPIRED,
  'not-yet-valid': GNUTLS_CERT_INVALID | GNUTLS_CERT_NOT_ACTIVATED,
  revoked: GNUTLS_CERT_INVALID | GNUTLS_CERT_REVOKED,
  'not-a-ca': GNUTLS_CERT_INVALID | GNUTLS_CERT_SIGNER_NOT_CA,
  'bad-signature': GNUTLS_CERT_INVALID | GNUTLS_CERT_SIGNATURE_FAILURE,
};

const accepted: PeerVerdict = { ok: true };

function refusal(errno: number | null, ...lines: TraceLine[]): PeerVerdict {
  return { ok: false, errno, lines };
}

function anyLevel(text: string): TraceLine {
  return { level: LdapDebug.ANY, text };
}

export function judgeChain(
  requireCert: number, certificate: X509Certificate | null, verification: ChainVerification,
): PeerVerdict {
  if (requireCert === TlsRequireCert.NEVER) return accepted;
  if (certificate === null && requireCert === TlsRequireCert.TRY) return accepted;
  if (verification.ok !== false || requireCert === TlsRequireCert.ALLOW) return accepted;
  const status = STATUS_OF_REASON[verification.reason] ?? GNUTLS_CERT_INVALID;
  return refusal(null, { level: LdapDebug.TRACE, text: `TLS: peer cert untrusted or revoked (0x${status.toString(16)})\n` });
}

type NameKind = 'dns' | 'ipv4' | 'ipv6';

function nameKindOf(name: string): NameKind {
  if (IPv6Address.tryParse(name) !== null) return 'ipv6';
  const dot = name.lastIndexOf('.');
  if (dot >= 0 && /[0-9]/.test(name.charAt(dot + 1)) && inetAton(name) !== null) return 'ipv4';
  return 'dns';
}

function addressBytes(kind: NameKind, name: string): readonly number[] | null {
  if (kind === 'ipv4') return inetAton(name)?.getOctets() ?? null;
  if (kind === 'ipv6') return IPv6Address.tryParse(name)?.getHextets().flatMap((hextet) => [hextet >> 8, hextet & 0xff]) ?? null;
  return null;
}

function sanAddressBytes(text: string): readonly number[] | null {
  const ipv4 = IPAddress.tryParse(text);
  if (ipv4 !== null) return ipv4.getOctets();
  return IPv6Address.tryParse(text)?.getHextets().flatMap((hextet) => [hextet >> 8, hextet & 0xff]) ?? null;
}

function sameText(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function wildcardMatches(pattern: string, domain: string | null): boolean {
  return domain !== null && pattern.startsWith('*.') && sameText(domain, pattern.slice(1));
}

const SUBJECT_ALT_NAME_ERROR_MISSING = 'TLS: unable to get subjectAltName from peer certificate.\n';

function hostCheck(
  requireSan: number, nameIn: string | null, certificate: X509Certificate, localFqdn: string,
): PeerVerdict {
  const name = nameIn === null || sameText(nameIn, 'localhost') ? localFqdn : nameIn;
  const kind = nameKindOf(name);
  const firstDot = name.indexOf('.');
  const domain = kind === 'dns' && firstDot >= 0 ? name.slice(firstDot) : null;

  if (requireSan === TlsRequireCert.NEVER) return accepted;

  let sawSubjectAltName = false;
  const wanted = kind === 'dns' ? null : addressBytes(kind, name);
  for (const entry of certificate.extensions?.subjectAltName ?? []) {
    sawSubjectAltName = true;
    const separator = entry.indexOf(':');
    const type = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (value === '') continue;
    if (type === 'DNS' && kind === 'dns') {
      if (sameText(name, value) || wildcardMatches(value, domain)) return accepted;
    } else if (type === 'IP' && kind !== 'dns') {
      const bytes = sanAddressBytes(value);
      const expectedLength = kind === 'ipv6' ? 16 : 4;
      if (bytes !== null && bytes.length === expectedLength && wanted !== null && bytes.every((byte, index) => byte === wanted[index])) {
        return accepted;
      }
    }
  }

  if (requireSan === TlsRequireCert.DEMAND || requireSan === TlsRequireCert.HARD) {
    if (!sawSubjectAltName) return refusal(LdapRc.CONNECT_ERROR, anyLevel(SUBJECT_ALT_NAME_ERROR_MISSING));
  }
  if (requireSan !== TlsRequireCert.ALLOW && sawSubjectAltName) {
    return refusal(
      LdapRc.CONNECT_ERROR,
      anyLevel(`TLS: hostname (${name}) does not match subjectAltName in certificate.\n`),
    );
  }

  const commonNames = splitDistinguishedName(certificate.subject).filter((attribute) => attribute.type.toUpperCase() === 'CN');
  const commonName = commonNames.length === 0 ? null : commonNames[commonNames.length - 1].value;
  if (commonName === null) {
    return refusal(LdapRc.CONNECT_ERROR, anyLevel('TLS: unable to get common name from peer certificate.\n'));
  }
  if (sameText(name, commonName) || wildcardMatches(commonName, domain)) return accepted;
  return refusal(
    LdapRc.CONNECT_ERROR,
    anyLevel(`TLS: hostname (${name}) does not match common name in certificate (${commonName}).\n`),
  );
}

type Digest = (input: Uint8Array) => Uint8Array;

const PIN_DIGESTS: Readonly<Record<string, Digest>> = {
  md5, sha1, sha224, sha256, sha384, sha512,
  'sha3-224': (input) => sha3(224, input),
  'sha3-256': (input) => sha3(256, input),
  'sha3-384': (input) => sha3(384, input),
  'sha3-512': (input) => sha3(512, input),
};

const PIN_DIGESTS_WITHOUT_FINGERPRINT: readonly string[] = ['md2'];

function pinCheck(pin: NonNullable<LdapOptions['tls']['peerKeyHash']>, certificate: X509Certificate): PeerVerdict {
  let digest: Digest | null = null;
  if (pin.algorithm !== null) {
    const name = pin.algorithm.toLowerCase();
    if (PIN_DIGESTS_WITHOUT_FINGERPRINT.includes(name)) return refusal(LdapRc.SERVER_DOWN);
    digest = PIN_DIGESTS[name] ?? null;
    if (digest === null) {
      return refusal(
        LdapRc.SERVER_DOWN,
        anyLevel(`tlsg_session_pinning: unknown hashing algorithm for GnuTLS: '${pin.algorithm}'\n`),
      );
    }
  }
  const key = encodeSubjectPublicKeyInfo(certificate.publicKey);
  const hashed = digest === null ? key : digest(key);
  const same = hashed.length === pin.hash.length && hashed.every((byte, index) => byte === pin.hash[index]);
  return same ? accepted : refusal(LdapRc.CONNECT_ERROR, anyLevel('tlsg_session_pinning: public key hash does not match provided pin.\n'));
}

export function judgePeer(
  tls: LdapOptions['tls'], host: string | null, certificate: X509Certificate, localFqdn: string,
): PeerVerdict {
  if (tls.requireCert !== TlsRequireCert.NEVER && tls.requireCert !== TlsRequireCert.ALLOW) {
    const verdict = hostCheck(tls.requireSan, host, certificate, localFqdn);
    if (verdict.ok === false) return verdict;
  }
  return tls.peerKeyHash === null ? accepted : pinCheck(tls.peerKeyHash, certificate);
}
