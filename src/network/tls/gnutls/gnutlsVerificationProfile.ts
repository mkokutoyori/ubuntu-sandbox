import { modulusHex } from '@/crypto/rsa';
import type { X509Certificate } from '@/network/pki/X509Certificate';

export type VerificationProfile =
  | 'VERY_WEAK' | 'LOW' | 'LEGACY' | 'MEDIUM' | 'HIGH' | 'ULTRA' | 'FUTURE' | 'SUITEB128' | 'SUITEB192';

export interface VerificationSettings {
  readonly profile: VerificationProfile | null;
  readonly allowSha1: boolean;
  readonly allowBroken: boolean;
  readonly allowMd5: boolean;
}

export type SignatureHash = 'md2' | 'md5' | 'sha1' | 'sha224' | 'sha256' | 'sha384' | 'sha512';
export type CurveName = 'secp192r1' | 'secp224r1' | 'secp256r1' | 'secp384r1' | 'secp521r1';

export interface ProfiledCertificate {
  readonly subject: string;
  readonly issuer: string;
  readonly version: number;
  readonly keyKind: 'rsa' | 'ec';
  readonly keyBits: number;
  readonly curve: CurveName | null;
  readonly keyIdentity: string;
  readonly signatureKind: 'rsa' | 'ecdsa';
  readonly signatureHash: SignatureHash;
}

export const GNUTLS_CERT_INVALID = 0x2;
export const GNUTLS_CERT_INSECURE_ALGORITHM = 0x100;

interface SecurityParameter {
  readonly symmetricBits: number;
  readonly rsaBits: number;
  readonly curveBits: number;
}

const SECURITY_PARAMETERS: readonly (readonly [number, SecurityParameter])[] = [
  [5, { symmetricBits: 0, rsaBits: 0, curveBits: 0 }],
  [10, { symmetricBits: 42, rsaBits: 512, curveBits: 0 }],
  [15, { symmetricBits: 64, rsaBits: 767, curveBits: 1 }],
  [20, { symmetricBits: 72, rsaBits: 1008, curveBits: 160 }],
  [25, { symmetricBits: 80, rsaBits: 1024, curveBits: 160 }],
  [30, { symmetricBits: 96, rsaBits: 1776, curveBits: 192 }],
  [35, { symmetricBits: 112, rsaBits: 2048, curveBits: 224 }],
  [40, { symmetricBits: 128, rsaBits: 3072, curveBits: 256 }],
  [45, { symmetricBits: 192, rsaBits: 8192, curveBits: 384 }],
  [50, { symmetricBits: 256, rsaBits: 15360, curveBits: 512 }],
];

export const LEVEL_OF_PROFILE: Readonly<Record<VerificationProfile, number>> = {
  VERY_WEAK: 15, LOW: 25, LEGACY: 30, MEDIUM: 35, HIGH: 40, ULTRA: 45, FUTURE: 50, SUITEB128: 40, SUITEB192: 45,
};

const MAXIMUM_DH_REQUIREMENT_BITS = 3072;

const HASH_OUTPUT_BITS: Readonly<Record<SignatureHash, number>> = {
  md2: 128, md5: 128, sha1: 160, sha224: 224, sha256: 256, sha384: 384, sha512: 512,
};

const BROKEN_HASHES: readonly SignatureHash[] = ['md2', 'md5', 'sha1'];
const CURVE_ORDER: readonly CurveName[] = ['secp192r1', 'secp224r1', 'secp256r1', 'secp384r1', 'secp521r1'];
const INSECURE = GNUTLS_CERT_INSECURE_ALGORITHM | GNUTLS_CERT_INVALID;

export function securityLevelOfKey(kind: 'rsa' | 'ec', bits: number): number {
  let level = SECURITY_PARAMETERS[0][0];
  for (const [value, parameter] of SECURITY_PARAMETERS) {
    const needed = kind === 'ec' ? parameter.curveBits : parameter.rsaBits;
    if (needed > bits) break;
    level = value;
  }
  return level;
}

export function minimumDhPrimeBits(level: number): number {
  const required = SECURITY_PARAMETERS.find(([value]) => value === level)?.[1].rsaBits ?? 0;
  return Math.min(required, MAXIMUM_DH_REQUIREMENT_BITS);
}

function hashStrength(hash: SignatureHash): number {
  return HASH_OUTPUT_BITS[hash] / 2;
}

function symmetricBitsOf(level: number): number {
  return SECURITY_PARAMETERS.find(([value]) => value === level)?.[1].symmetricBits ?? 0;
}

function sameKey(left: ProfiledCertificate, right: ProfiledCertificate): boolean {
  return left.subject === right.subject && left.keyIdentity === right.keyIdentity;
}

function suiteBAcceptable(
  profile: 'SUITEB128' | 'SUITEB192', certificate: ProfiledCertificate, issuer: ProfiledCertificate | null,
): boolean {
  if (certificate.version !== 3) return false;
  const ecdsaHash = certificate.signatureKind === 'ecdsa' ? certificate.signatureHash : null;
  if (ecdsaHash !== 'sha256' && ecdsaHash !== 'sha384') return false;
  if (certificate.keyKind !== 'ec') return false;
  if (issuer === null || issuer.keyKind !== 'ec') return false;
  if (certificate.curve !== 'secp256r1' && certificate.curve !== 'secp384r1') return false;
  if (profile === 'SUITEB192' && certificate.curve !== 'secp384r1') return false;
  if (issuer.version !== 3) return false;
  if (issuer.curve !== 'secp256r1' && issuer.curve !== 'secp384r1') return false;
  if (CURVE_ORDER.indexOf(issuer.curve) < CURVE_ORDER.indexOf(certificate.curve)) return false;
  return !(ecdsaHash === 'sha256' && issuer.curve === 'secp384r1');
}

function levelAcceptable(
  profile: VerificationProfile | null, certificate: ProfiledCertificate, issuer: ProfiledCertificate | null, trusted: boolean,
): boolean {
  if (profile === null) return true;
  if (profile === 'SUITEB128' || profile === 'SUITEB192') return suiteBAcceptable(profile, certificate, issuer);
  const level = LEVEL_OF_PROFILE[profile];
  if (!trusted && hashStrength(certificate.signatureHash) < symmetricBitsOf(level)) return false;
  if (securityLevelOfKey(certificate.keyKind, certificate.keyBits) < level) return false;
  return issuer === null || securityLevelOfKey(issuer.keyKind, issuer.keyBits) >= level;
}

function signatureAllowed(settings: VerificationSettings, certificate: ProfiledCertificate): boolean {
  if (!BROKEN_HASHES.includes(certificate.signatureHash)) return true;
  if (settings.allowBroken) return true;
  if (certificate.signatureHash === 'sha1') return settings.allowSha1;
  return certificate.signatureHash === 'md5' && certificate.signatureKind === 'rsa' && settings.allowMd5;
}

function step(
  settings: VerificationSettings, certificate: ProfiledCertificate, issuer: ProfiledCertificate | null,
): boolean {
  if (!levelAcceptable(settings.profile, certificate, issuer, false)) return false;
  const selfIssued = certificate.subject === certificate.issuer;
  return selfIssued || signatureAllowed(settings, certificate);
}

export interface ProfileJudgement {
  readonly status: number;
  readonly decisive: boolean;
}

export function judgeAlgorithms(
  settings: VerificationSettings, peerChain: readonly ProfiledCertificate[], trusted: readonly ProfiledCertificate[],
): ProfileJudgement {
  const chain = [...peerChain];
  if (chain.length > 1 && chain[chain.length - 1].subject === chain[chain.length - 1].issuer) chain.pop();
  let length = chain.length;
  for (let index = 0; index < chain.length; index++) {
    const anchor = trusted.find((candidate) => sameKey(chain[index], candidate));
    if (anchor === undefined) continue;
    if (!levelAcceptable(settings.profile, anchor, null, true)) return { status: INSECURE, decisive: true };
    length = index;
    break;
  }
  let status = 0;
  const issuerOf = (certificate: ProfiledCertificate): ProfiledCertificate | null =>
    trusted.find((candidate) => candidate.subject === certificate.issuer) ?? null;
  if (length > 0 && !step(settings, chain[length - 1], issuerOf(chain[length - 1]))) status |= INSECURE;
  for (let index = length - 1; index > 0; index--) {
    if (!step(settings, chain[index - 1], chain[index])) status |= INSECURE;
  }
  return { status, decisive: false };
}

const HASH_IN_ALGORITHM: readonly (readonly [RegExp, SignatureHash])[] = [
  [/sha512/i, 'sha512'], [/sha384/i, 'sha384'], [/sha256/i, 'sha256'], [/sha224/i, 'sha224'], [/sha1/i, 'sha1'], [/md5/i, 'md5'], [/md2/i, 'md2'],
];

export function profiledCertificate(certificate: X509Certificate): ProfiledCertificate {
  const ecdsa = certificate.publicKey.algorithm === 'ecdsa';
  const modulus = ecdsa ? null : modulusHex(certificate.publicKey.material);
  const stripped = modulus === null ? '' : modulus.replace(/^0+/, '');
  return {
    subject: certificate.subject,
    issuer: certificate.issuer,
    version: certificate.version,
    keyKind: ecdsa ? 'ec' : 'rsa',
    keyBits: ecdsa ? 256 : stripped === '' ? 0 : (stripped.length - 1) * 4 + 32 - Math.clz32(parseInt(stripped.charAt(0), 16)),
    curve: ecdsa ? 'secp256r1' : null,
    keyIdentity: certificate.publicKey.material,
    signatureKind: certificate.signatureAlgorithm.startsWith('ecdsa') ? 'ecdsa' : 'rsa',
    signatureHash: HASH_IN_ALGORITHM.find(([pattern]) => pattern.test(certificate.signatureAlgorithm))?.[1] ?? 'sha256',
  };
}
