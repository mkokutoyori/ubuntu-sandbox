import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { LegacyVersion } from './legacyCipherSuites';
import type { OcspResponseMessage } from '@/network/pki/OcspWire';

export interface LegacyServerHello {
  readonly kind: 'legacy_server_hello';
  readonly version: LegacyVersion;
  readonly random: string;
  readonly sessionId: string;
  readonly cipherSuite: string;
  readonly compressionMethod: 'null';
  readonly extensions: {
    readonly alpn?: string;
    readonly ecPointFormats?: readonly string[];
    readonly extendedMasterSecret?: boolean;
    readonly renegotiationInfo?: string;
    readonly sessionTicket?: boolean;
    readonly statusRequest?: boolean;
    readonly maxFragmentLength?: number;
  };
}

export interface LegacyCertificate {
  readonly kind: 'legacy_certificate';
  readonly certificateList: readonly X509Certificate[];
}

export type KeyExchangeParams =
  | { readonly type: 'ecdh'; readonly group: string; readonly publicKey: string }
  | { readonly type: 'dh'; readonly p: string; readonly g: string; readonly ys: string };

export interface ServerKeyExchange {
  readonly kind: 'server_key_exchange';
  readonly params: KeyExchangeParams;
  readonly signatureAlgorithm: string;
  readonly signature: string;
}

export interface LegacyCertificateRequest {
  readonly kind: 'legacy_certificate_request';
  readonly certificateTypes: readonly string[];
  readonly signatureAlgorithms: readonly string[];
}

export interface ServerHelloDone {
  readonly kind: 'server_hello_done';
}

export interface ClientKeyExchange {
  readonly kind: 'client_key_exchange';
  readonly exchange:
    | { readonly type: 'ecdh'; readonly publicKey: string }
    | { readonly type: 'dh'; readonly yc: string }
    | { readonly type: 'rsa'; readonly encryptedPreMasterSecret: string };
}

export interface LegacyCertificateVerify {
  readonly kind: 'legacy_certificate_verify';
  readonly signatureAlgorithm?: string;
  readonly signature: string;
}

export interface LegacyFinished {
  readonly kind: 'legacy_finished';
  readonly verifyData: string;
}

export interface LegacyCertificateStatus {
  readonly kind: 'legacy_certificate_status';
  readonly response: OcspResponseMessage;
}

export interface LegacyNewSessionTicket {
  readonly kind: 'legacy_new_session_ticket';
  readonly lifetimeHint: number;
  readonly ticket: string;
}

export type LegacyHandshakeMessage =
  | LegacyCertificateStatus
  | LegacyNewSessionTicket
  | LegacyServerHello | LegacyCertificate | ServerKeyExchange | LegacyCertificateRequest
  | ServerHelloDone | ClientKeyExchange | LegacyCertificateVerify | LegacyFinished;

export { encodeLegacyMessage, decodeLegacyMessages, encodeLegacyBundle, type LegacyWireContext } from '../wire/LegacyHandshakeCodec';
