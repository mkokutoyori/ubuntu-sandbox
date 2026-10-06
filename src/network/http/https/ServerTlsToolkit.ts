import { simulationNowMs } from '@/network/core/SystemClock';

import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { CertificateRevocationList } from '@/network/pki/CertificateRevocationList';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { IOcspResponder } from '@/network/pki/OcspResponder';
import type { PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import { generateSelfSignedCertificate } from '@/network/pki/SelfSignedCertificate';
import { splitPemChain, pemToCrl, pemToCertChain } from '@/network/pki/pem';
import { LegacySessionStore } from '@/network/tls/legacy/legacySessions';
import { SessionTicketStore } from '@/network/tls/sessionTickets';
import { sha256 } from '@/crypto/hash';
import type { TlsServerCredential } from '@/network/tls/TlsServerSession';
import type { TlsProtocolVersion } from '@/network/tls/legacy/legacyCipherSuites';

export interface ServerIdentity {
  readonly cert: X509Certificate;
  readonly key: PkiPrivateKey;
  readonly chain: readonly X509Certificate[];
}

export function fopenFailure(path: string): string {
  return `error:80000002:system library::No such file or directory:calling fopen(${path}, r) `
    + 'error:10000080:BIO routines::no such file';
}

export function loadLocationsFailure(path: string): string {
  return `SSL_CTX_load_verify_locations("${path}") failed (SSL: ${fopenFailure(path)} `
    + 'error:05880002:x509 certificate routines::system lib)';
}

export function bytesOfText(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export function ticketKeyFromFile(content: string): Uint8Array {
  return sha256(bytesOfText(content));
}

export function randomTicketKey(): Uint8Array {
  const key = new Uint8Array(32);
  for (let i = 0; i < key.length; i++) key[i] = Math.floor(Math.random() * 256);
  return key;
}

export function ephemeralIdentity(): ServerIdentity {
  const generated = generateSelfSignedCertificate('CN=reject-handshake', { now: simulationNowMs() });
  return { cert: generated.cert, key: generated.privateKey, chain: [] };
}

export function crlsFromPem(text: string): CertificateRevocationList[] {
  const out: CertificateRevocationList[] = [];
  for (const block of splitPemChain(text)) {
    const crl = pemToCrl(block);
    if (crl) out.push(crl);
  }
  return out;
}

export interface ClientVerifierInput {
  readonly anchors: readonly X509Certificate[];
  readonly crls: readonly CertificateRevocationList[];
  readonly crlChecking: boolean;
  readonly revocationScope: 'leaf' | 'chain';
  readonly missingCrlOk: boolean;
  readonly maxDepth: number;
  readonly ocsp?: { readonly responder: IOcspResponder; readonly scope: 'leaf' | 'chain'; readonly missingOk: boolean };
}

export function buildClientVerifier(input: ClientVerifierInput): CertificateVerifier {
  return new CertificateVerifier({
    trustAnchors: input.anchors,
    crls: input.crls,
    revocationCheck: input.ocsp ? 'ocsp' : input.crlChecking ? 'crl-strict' : 'none',
    crlMode: 'crl-strict',
    ...(input.ocsp ? { ocspResponder: input.ocsp.responder, ocspScope: input.ocsp.scope, missingOcspOk: input.ocsp.missingOk } : {}),
    revocationScope: input.revocationScope,
    missingCrlOk: input.missingCrlOk,
    maxDepth: input.maxDepth,
  });
}

export function anchorsFromPem(...texts: readonly string[]): X509Certificate[] {
  return texts.flatMap((text) => pemToCertChain(text));
}

export interface ResumptionPolicy {
  readonly tickets: boolean;
  readonly serverSideCache: boolean;
  readonly timeoutSeconds: number;
  readonly ticketKey: Uint8Array | undefined;
}

export function resumptionConfig(policy: ResumptionPolicy): {
  readonly legacySessionStore: LegacySessionStore | undefined;
  readonly sessionTicketKey: Uint8Array | undefined;
  readonly sessionTicketStore: SessionTicketStore | undefined;
  readonly sessionTimeoutSeconds: number;
} {
  return {
    legacySessionStore: policy.serverSideCache ? new LegacySessionStore(policy.timeoutSeconds) : undefined,
    sessionTicketKey: policy.tickets ? policy.ticketKey ?? randomTicketKey() : undefined,
    sessionTicketStore: policy.tickets || policy.serverSideCache ? new SessionTicketStore() : undefined,
    sessionTimeoutSeconds: policy.timeoutSeconds,
  };
}

export function credentialFor(
  identity: ServerIdentity, matches: (name: string) => boolean, rejectHandshake: boolean,
  protocols?: readonly TlsProtocolVersion[],
): TlsServerCredential {
  return {
    cert: identity.cert, privateKey: identity.key, chain: identity.chain, matches, rejectHandshake,
    ...(protocols ? { protocols } : {}),
  };
}
