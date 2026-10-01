import type { PkiPublicKey } from '@/network/pki/PkiKeyPair';
import { modulusHex } from '@/crypto/rsa';
import type { TlsProtocolVersion, LegacySuiteDefinition } from './legacyCipherSuites';

export const DEFAULT_SECURITY_LEVEL = 1;

const MIN_BITS: readonly number[] = [0, 80, 112, 128, 192, 256];
const LOG_2 = Math.LN2;

export function clampLevel(level: number): number {
  return Math.min(5, Math.max(0, level));
}

export function minimumBits(level: number): number {
  return MIN_BITS[clampLevel(level)];
}

export function ffcSecurityBits(modulusBits: number): number {
  switch (modulusBits) {
    case 2048: return 112;
    case 3072: return 128;
    case 4096: return 152;
    case 6144: return 176;
    case 7680: return 192;
    case 8192: return 200;
    case 15360: return 256;
    default: break;
  }
  if (modulusBits >= 687737) return 1200;
  if (modulusBits < 8) return 0;
  const cap = modulusBits <= 7680 ? 192 : modulusBits <= 15360 ? 256 : 1200;
  const x = modulusBits * LOG_2;
  const lx = Math.log(x);
  const raw = (1.923 * Math.cbrt(x * lx * lx) - 4.69) / LOG_2;
  return Math.min(cap, (Math.floor(raw) + 4) & ~7);
}

export function keySecurityBits(publicKey: PkiPublicKey): number {
  if (publicKey.algorithm === 'ecdsa') return 128;
  const modulus = modulusHex(publicKey.material);
  if (modulus === null) return -1;
  return ffcSecurityBits(modulus.replace(/^0+/, '').length * 4);
}

export function versionPermitted(level: number, version: TlsProtocolVersion): boolean {
  const lvl = clampLevel(level);
  if (version === '1.0' && lvl >= 3) return false;
  if (version === '1.1' && lvl >= 4) return false;
  return true;
}

export function cipherPermitted(level: number, suite: LegacySuiteDefinition): boolean {
  const lvl = clampLevel(level);
  if (lvl === 0) return true;
  const minbits = minimumBits(lvl);
  if (suite.strengthBits < minbits) return false;
  if (minbits > 160 && suite.mac === 'SHA1') return false;
  if (lvl >= 3 && suite.keyExchange === 'RSA') return false;
  return true;
}

export function tls13CipherPermitted(level: number, strengthBits: number): boolean {
  const lvl = clampLevel(level);
  return lvl === 0 || strengthBits >= minimumBits(lvl);
}

export function keyPermitted(level: number, publicKey: PkiPublicKey): boolean {
  const lvl = clampLevel(level);
  if (lvl === 0) return true;
  return keySecurityBits(publicKey) >= minimumBits(lvl);
}

export function dhPermitted(level: number, primeBits: number): boolean {
  const lvl = clampLevel(level);
  const bits = ffcSecurityBits(primeBits);
  if (lvl === 0) return bits >= 80;
  return bits >= minimumBits(lvl);
}
