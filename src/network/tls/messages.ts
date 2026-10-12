/**
 * TLS 1.3 (RFC 8446 §4) handshake messages — deliberately abstracted at the
 * same fidelity level as `EapTlsHandshake.ts`: real message ordering/shape,
 * but each message is a JSON-serializable object ("flight") rather than a
 * real ASN.1/DER-encoded TLS record, and signature/MAC fields are opaque
 * strings computed elsewhere (key schedule, PKI) rather than real crypto.
 */
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { OcspResponseMessage } from '@/network/pki/OcspWire';
import type { CipherSuite } from './types';
import { HELLO_RETRY_REQUEST_RANDOM } from './types';
import { encodeTls13Message, decodeTls13Message, splitHandshakeMessages } from './wire/Tls13HandshakeCodec';
import { TlsDecodeError } from './wire/TlsBytes';

export interface ClientHelloExtensions {
  readonly supportedVersions: readonly string[];
  readonly keyShare: string;
  readonly supportedGroups: readonly string[];
  readonly signatureAlgorithms: readonly string[];
  readonly serverName?: string;
  readonly statusRequest?: boolean;
  readonly maxFragmentLength?: number;
  readonly alpn?: readonly string[];
  readonly pskKeyExchangeModes?: readonly string[];
  readonly preSharedKey?: string;
  readonly pskOffers?: readonly PskOffer[];
  readonly earlyData?: boolean;
}

export interface PskOffer {
  readonly identity: string;
  readonly obfuscatedAge: number;
  readonly binder: string;
}

export interface LegacyClientExtensions {
  readonly sessionId: string;
  readonly extendedMasterSecret: boolean;
  readonly renegotiationInfo: string | null;
  readonly sessionTicket: string | null;
}

export interface ClientHello {
  readonly kind: 'client_hello';
  readonly legacyVersion: string;
  readonly random: string;
  readonly cipherSuites: readonly CipherSuite[];
  readonly legacyCipherSuites?: readonly number[];
  readonly legacyExtensions?: LegacyClientExtensions;
  readonly extensions: ClientHelloExtensions;
}

export interface ServerHelloExtensions {
  readonly supportedVersions: string;
  readonly keyShare?: string;
  readonly preSharedKey?: string;
  readonly pskSelectedIdentity?: number;
}

export interface ServerHello {
  readonly kind: 'server_hello';
  readonly random: string;
  readonly sessionIdEcho?: string;
  readonly cipherSuite: CipherSuite;
  readonly extensions: ServerHelloExtensions;
}

export interface HelloRetryRequest {
  readonly kind: 'hello_retry_request';
  readonly random: typeof HELLO_RETRY_REQUEST_RANDOM;
  readonly selectedGroup: string;
  readonly cipherSuite?: CipherSuite;
  readonly sessionIdEcho?: string;
}

export interface EncryptedExtensionsMessage {
  readonly kind: 'encrypted_extensions';
  readonly extensions: { readonly alpn?: string; readonly earlyData?: boolean; readonly maxFragmentLength?: number };
}

export interface CertificateRequest {
  readonly kind: 'certificate_request';
  readonly certificateRequestContext: string;
  readonly signatureAlgorithms: readonly string[];
}

export interface CertificateMessage {
  readonly kind: 'certificate';
  readonly certificateList: readonly X509Certificate[];
  readonly ocspStaple?: OcspResponseMessage;
}

export interface CertificateVerify {
  readonly kind: 'certificate_verify';
  readonly signatureAlgorithm?: string;
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
  readonly extensions: { readonly earlyData?: boolean; readonly maxEarlyDataSize?: number };
}

export interface KeyUpdate {
  readonly kind: 'key_update';
  readonly requestUpdate: boolean;
}

export interface EndOfEarlyData {
  readonly kind: 'end_of_early_data';
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
  | KeyUpdate
  | EndOfEarlyData;

export function encodeHandshakeMessage(message: TlsHandshakeMessage): Uint8Array {
  return encodeTls13Message(message);
}

export function decodeHandshakeMessage(bytes: Uint8Array): TlsHandshakeMessage {
  const [first] = splitHandshakeMessages(bytes);
  if (first === undefined) throw new TlsDecodeError('empty handshake message');
  return decodeTls13Message(first.type, first.body);
}

export function encodeMessages(messages: readonly TlsHandshakeMessage[]): Uint8Array {
  const parts = messages.map(encodeTls13Message);
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

export function decodeMessages(bytes: Uint8Array): TlsHandshakeMessage[] {
  return splitHandshakeMessages(bytes).map((entry) => decodeTls13Message(entry.type, entry.body));
}

export interface RawHandshakeMessage {
  readonly message: TlsHandshakeMessage;
  readonly raw: Uint8Array;
}

export function decodeMessagesRaw(bytes: Uint8Array): RawHandshakeMessage[] {
  return splitHandshakeMessages(bytes).map((entry) => ({ message: decodeTls13Message(entry.type, entry.body), raw: entry.raw }));
}

let nonceCounter = 0;

/** Deterministic-but-unique nonce generator, same shape as `EapTlsHandshake.randomNonce`. */
export function randomNonce(prefix: string): string {
  nonceCounter += 1;
  return `${prefix}-${nonceCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
