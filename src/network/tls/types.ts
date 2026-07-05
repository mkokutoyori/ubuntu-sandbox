/**
 * TLS 1.3 (RFC 8446) — shared constants and primitive types, at the same
 * simulated-crypto fidelity level as the rest of this project (`PkiKeyPair`,
 * `SimulatedTls.ts`, `EapTlsHandshake.ts`): real protocol mechanics (message
 * ordering, record framing, content-type codes), simulated cryptography.
 */

export type TlsVersion = '1.3';

/** RFC 8446 §5.1 ContentType — numeric codes match the RFC's registry. */
export type ContentType = 'invalid' | 'change_cipher_spec' | 'alert' | 'handshake' | 'application_data';

export const CONTENT_TYPE_CODE: Record<ContentType, number> = {
  invalid: 0,
  change_cipher_spec: 20,
  alert: 21,
  handshake: 22,
  application_data: 23,
};

export const CONTENT_TYPE_FROM_CODE: Record<number, ContentType> = Object.fromEntries(
  Object.entries(CONTENT_TYPE_CODE).map(([name, code]) => [code, name as ContentType]),
);

export type AlertLevel = 'warning' | 'fatal';

export type HandshakeType =
  | 'client_hello' | 'server_hello' | 'hello_retry_request' | 'encrypted_extensions'
  | 'certificate_request' | 'certificate' | 'certificate_verify' | 'finished'
  | 'new_session_ticket' | 'key_update';

/** RFC 8446 §B.4 — the five mandatory-to-implement cipher suites. */
export type CipherSuite =
  | 'TLS_AES_128_GCM_SHA256'
  | 'TLS_AES_256_GCM_SHA384'
  | 'TLS_CHACHA20_POLY1305_SHA256'
  | 'TLS_AES_128_CCM_SHA256'
  | 'TLS_AES_128_CCM_8_SHA256';

/** RFC 8446 §5.1 — plaintext fragment ceiling per record (2^14 bytes). */
export const MAX_TLS_RECORD_LENGTH = 16384;

/**
 * RFC 8446 §5.1 — the record layer's `legacy_record_version` stays frozen
 * at TLS 1.2 (0x0303) for middlebox compatibility, even though the
 * negotiated version is 1.3.
 */
export const TLS_LEGACY_RECORD_VERSION = 0x0303;

/** RFC 8446 §4.1.3 — magic random value identifying a HelloRetryRequest. */
export const HELLO_RETRY_REQUEST_RANDOM = 'HelloRetryRequest-magic';
