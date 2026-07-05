/**
 * TLS 1.3 (RFC 8446 §B.4) cipher suite registry and negotiation. The
 * cryptography behind each suite stays simulated (project-wide
 * convention), but the *choice* of suite is negotiated for real: the
 * server picks, in its own preference order, the first suite the client
 * also offered — never a suite the client didn't propose.
 */
import type { CipherSuite } from './types';

/** RFC 8446 §B.4 — the five mandatory-to-implement cipher suites, canonical order. */
export const MANDATORY_CIPHER_SUITES: readonly CipherSuite[] = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'TLS_AES_128_CCM_SHA256',
  'TLS_AES_128_CCM_8_SHA256',
];

/**
 * Simulated per-suite AEAD tag length — real values for the AES-GCM/
 * ChaCha20-Poly1305/CCM suites are all 16 bytes except the "_8_" CCM
 * variant's shortened 8-byte tag (RFC 6655). Not used for real encryption
 * here, but makes the negotiated suite an observable, testable parameter
 * (PRD-TLS.md §2.1.11) rather than an inert label.
 */
export const CIPHER_SUITE_TAG_LENGTH: Record<CipherSuite, number> = {
  TLS_AES_128_GCM_SHA256: 16,
  TLS_AES_256_GCM_SHA384: 16,
  TLS_CHACHA20_POLY1305_SHA256: 16,
  TLS_AES_128_CCM_SHA256: 16,
  TLS_AES_128_CCM_8_SHA256: 8,
};

/**
 * RFC 8446 §4.1.1 — the server negotiates from its own preference order,
 * restricted to suites the client actually offered. Returns null if there
 * is no overlap at all (the caller should then fail the handshake).
 */
export function selectCipherSuite(
  clientOffered: readonly CipherSuite[],
  serverPreference: readonly CipherSuite[],
): CipherSuite | null {
  return serverPreference.find((suite) => clientOffered.includes(suite)) ?? null;
}
