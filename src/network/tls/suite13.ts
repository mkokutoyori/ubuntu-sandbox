import type { Tls13Hash } from './hkdf';
import type { CipherSuite } from './types';

export type Tls13Aead = 'aes-gcm' | 'chacha20-poly1305' | 'aes-ccm';

export interface Tls13SuiteInfo {
  readonly name: CipherSuite;
  readonly hash: Tls13Hash;
  readonly aead: Tls13Aead;
  readonly keyLength: number;
  readonly ivLength: number;
  readonly tagLength: number;
  readonly strengthBits: number;
}

export const TLS13_SUITES: Readonly<Record<CipherSuite, Tls13SuiteInfo>> = {
  TLS_AES_128_GCM_SHA256: { name: 'TLS_AES_128_GCM_SHA256', hash: 'sha256', aead: 'aes-gcm', keyLength: 16, ivLength: 12, tagLength: 16, strengthBits: 128 },
  TLS_AES_256_GCM_SHA384: { name: 'TLS_AES_256_GCM_SHA384', hash: 'sha384', aead: 'aes-gcm', keyLength: 32, ivLength: 12, tagLength: 16, strengthBits: 256 },
  TLS_CHACHA20_POLY1305_SHA256: { name: 'TLS_CHACHA20_POLY1305_SHA256', hash: 'sha256', aead: 'chacha20-poly1305', keyLength: 32, ivLength: 12, tagLength: 16, strengthBits: 256 },
  TLS_AES_128_CCM_SHA256: { name: 'TLS_AES_128_CCM_SHA256', hash: 'sha256', aead: 'aes-ccm', keyLength: 16, ivLength: 12, tagLength: 16, strengthBits: 128 },
  TLS_AES_128_CCM_8_SHA256: { name: 'TLS_AES_128_CCM_8_SHA256', hash: 'sha256', aead: 'aes-ccm', keyLength: 16, ivLength: 12, tagLength: 8, strengthBits: 128 },
};

export const DEFAULT_SUITE_13: CipherSuite = 'TLS_AES_128_GCM_SHA256';

export interface Tls13Traffic {
  readonly secret: string;
  readonly suite: CipherSuite;
  readonly maxFragment?: number;
  readonly sequenceBase?: number;
}

export function suiteInfo(name: string | null | undefined): Tls13SuiteInfo {
  return (name !== null && name !== undefined ? TLS13_SUITES[name as CipherSuite] : undefined) ?? TLS13_SUITES[DEFAULT_SUITE_13];
}
