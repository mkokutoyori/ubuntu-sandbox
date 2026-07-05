/**
 * TLS 1.3 (RFC 8446 §4) handshake messages — deliberately abstracted at the
 * same fidelity level as `EapTlsHandshake.ts`: real message ordering/shape,
 * but each message is a JSON-serializable object ("flight") rather than a
 * real ASN.1/DER-encoded TLS record, and signature/MAC fields are opaque
 * strings computed elsewhere (key schedule, PKI) rather than real crypto.
 */
import { utf8ToBytes, bytesToUtf8 } from '@/crypto/encoding';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { CipherSuite } from './types';
import { HELLO_RETRY_REQUEST_RANDOM } from './types';

export interface ClientHelloExtensions {
  readonly supportedVersions: readonly string[];
  readonly keyShare: string;
  readonly supportedGroups: readonly string[];
  readonly signatureAlgorithms: readonly string[];
  readonly serverName?: string;
  readonly alpn?: readonly string[];
  readonly pskKeyExchangeModes?: readonly string[];
  readonly preSharedKey?: string;
  readonly earlyData?: boolean;
}

export interface ClientHello {
  readonly kind: 'client_hello';
  readonly legacyVersion: string;
  readonly random: string;
  readonly cipherSuites: readonly CipherSuite[];
  readonly extensions: ClientHelloExtensions;
}

export interface ServerHelloExtensions {
  readonly supportedVersions: string;
  readonly keyShare?: string;
  readonly preSharedKey?: string;
}

export interface ServerHello {
  readonly kind: 'server_hello';
  readonly random: string;
  readonly cipherSuite: CipherSuite;
  readonly extensions: ServerHelloExtensions;
}

export interface HelloRetryRequest {
  readonly kind: 'hello_retry_request';
  readonly random: typeof HELLO_RETRY_REQUEST_RANDOM;
  readonly selectedGroup: string;
}

export interface EncryptedExtensionsMessage {
  readonly kind: 'encrypted_extensions';
  readonly extensions: { readonly alpn?: string; readonly earlyData?: boolean };
}

export interface CertificateRequest {
  readonly kind: 'certificate_request';
  readonly certificateRequestContext: string;
  readonly signatureAlgorithms: readonly string[];
}

export interface CertificateMessage {
  readonly kind: 'certificate';
  readonly certificateList: readonly X509Certificate[];
}

export interface CertificateVerify {
  readonly kind: 'certificate_verify';
  readonly signature: string;
}

export interface Finished {
  readonly kind: 'finished';
  readonly verifyData: string;
}

export interface NewSessionTicket {
  readonly kind: 'new_session_ticket';
  readonly ticketLifetime: number;
  readonly ticketAgeAdd: string;
  readonly ticketNonce: string;
  readonly ticket: string;
  readonly extensions: { readonly earlyData?: boolean };
}

export interface KeyUpdate {
  readonly kind: 'key_update';
  readonly requestUpdate: boolean;
}

export type TlsHandshakeMessage =
  | ClientHello
  | ServerHello
  | HelloRetryRequest
  | EncryptedExtensionsMessage
  | CertificateRequest
  | CertificateMessage
  | CertificateVerify
  | Finished
  | NewSessionTicket
  | KeyUpdate;

export function encodeHandshakeMessage(message: TlsHandshakeMessage): Uint8Array {
  return utf8ToBytes(JSON.stringify(message));
}

export function decodeHandshakeMessage(bytes: Uint8Array): TlsHandshakeMessage {
  return JSON.parse(bytesToUtf8(bytes)) as TlsHandshakeMessage;
}

let nonceCounter = 0;

/** Deterministic-but-unique nonce generator, same shape as `EapTlsHandshake.randomNonce`. */
export function randomNonce(prefix: string): string {
  nonceCounter += 1;
  return `${prefix}-${nonceCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
