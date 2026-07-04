/**
 * EAP-TLS (RFC 5216) handshake content — deliberately abstracted at the
 * same fidelity level as the rest of this project's simulated crypto
 * (`PkiKeyPair`, `SimulatedTls.ts`): real X.509 certificate issuance/
 * verification (`@/network/pki`), but TLS handshake messages are grouped
 * into JSON-serializable "flights" rather than real ASN.1/DER-encoded TLS
 * records, and the Finished value is a deterministic simulated MAC over
 * both random nonces rather than a real PRF. `EapTlsFragmentation.ts`
 * chops a flight's encoded bytes into RFC 5216 §2.1 fragments; this module
 * only knows the flights' content and how to compute/check "Finished".
 */
import { utf8ToBytes, bytesToUtf8 } from '@/crypto/encoding';
import { simulatedDigest } from '@/network/dns/dnssec/Digest';
import type { X509Certificate } from '@/network/pki/X509Certificate';

export interface EapTlsClientHello {
  readonly kind: 'client-hello';
  readonly random: string;
}

export interface EapTlsServerFlight {
  readonly kind: 'server-flight';
  readonly random: string;
  readonly certificate: X509Certificate;
  readonly requestClientCert: boolean;
}

export interface EapTlsClientFlight {
  readonly kind: 'client-flight';
  readonly certificate: X509Certificate | null;
  readonly finished: string;
}

export interface EapTlsServerFinished {
  readonly kind: 'server-finished';
  readonly finished: string;
}

export type EapTlsFlight =
  | EapTlsClientHello | EapTlsServerFlight | EapTlsClientFlight | EapTlsServerFinished;

export function encodeFlight(flight: EapTlsFlight): Uint8Array {
  return utf8ToBytes(JSON.stringify(flight));
}

export function decodeFlight(bytes: Uint8Array): EapTlsFlight {
  return JSON.parse(bytesToUtf8(bytes)) as EapTlsFlight;
}

/**
 * A deterministic stand-in for the TLS Finished MAC: both sides derive the
 * same value from the two random nonces plus their role, so a mismatched
 * or tampered handshake (different nonce seen, wrong role) produces a
 * different value and is detected — without implementing a real PRF/MAC.
 */
export function computeFinished(clientRandom: string, serverRandom: string, role: 'client' | 'server'): string {
  return simulatedDigest(`${clientRandom}|${serverRandom}|${role}|finished`);
}

let nonceCounter = 0;

export function randomNonce(prefix: string): string {
  nonceCounter += 1;
  return `${prefix}-${nonceCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
