import { bytesToHex, hexToBytes } from '@/crypto/encoding';
import { sha256 } from '@/crypto/hash/sha256';
import { decodeCertificate, encodeCertificate } from '@/network/pki/der/X509Der';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { cipherSuiteCode, cipherSuiteName, isTls13CipherSuiteCode } from './wire/TlsRegistry';
import type { CipherSuite } from './types';
import { deriveResumptionPsk, type SessionTicket } from './sessionTickets';
import { legacySuiteByCode, legacySuiteByName, type LegacyVersion } from './legacy/legacyCipherSuites';
import type { LegacySessionState, ResumableLegacySession } from './legacy/legacySessions';
import type { SslSessionFields } from './sslSession';

export const TLS13_VERSION_CODE = 0x0304;
export const EXTENDED_MASTER_SECRET_FLAG = 0x1;
const LEGACY_VERSION_CODES: Readonly<Record<LegacyVersion, number>> = { '1.0': 0x0301, '1.1': 0x0302, '1.2': 0x0303 };

export interface SessionWriteContext {
  readonly peer?: X509Certificate;
  readonly verifyResult: number;
  readonly serverName?: string;
  readonly alpn?: string;
  readonly kexGroup?: number;
}

const u32 = (hex: string): number => parseInt(hex || '0', 16) >>> 0;

export function ticketToSslSession(ticket: SessionTicket, context: SessionWriteContext): SslSessionFields {
  const ticketBytes = hexToBytes(ticket.ticket);
  return {
    protocolVersion: TLS13_VERSION_CODE,
    cipherId: cipherSuiteCode(ticket.cipherSuite),
    sessionId: sha256(ticketBytes),
    masterKey: hexToBytes(deriveResumptionPsk(ticket)),
    time: Math.floor(ticket.issuedAt / 1000),
    timeout: ticket.ticketLifetime,
    ...(context.peer ? { peerDer: encodeCertificate(context.peer) } : {}),
    verifyResult: context.verifyResult,
    ...(context.serverName !== undefined ? { hostname: context.serverName } : {}),
    ticketLifetimeHint: ticket.ticketLifetime,
    ticket: ticketBytes,
    ticketAgeAdd: u32(ticket.ticketAgeAdd ?? ''),
    maxEarlyData: ticket.maxEarlyDataSize ?? 0,
    ...(context.alpn !== undefined ? { alpn: context.alpn } : {}),
    ...(context.kexGroup !== undefined ? { kexGroup: context.kexGroup } : {}),
  };
}

export type LoadedSession =
  | { readonly kind: 'tls13'; readonly ticket: SessionTicket }
  | { readonly kind: 'legacy'; readonly session: ResumableLegacySession }
  | { readonly kind: 'unsupported'; readonly reason: string };

export function sslSessionToResumable(fields: SslSessionFields): LoadedSession {
  if (fields.protocolVersion === TLS13_VERSION_CODE) {
    if (!isTls13CipherSuiteCode(fields.cipherId) || fields.ticket === undefined) {
      return { kind: 'unsupported', reason: 'the TLS 1.3 session carries no ticket this client can present' };
    }
    const peers: X509Certificate[] = fields.peerDer ? [decodeCertificate(fields.peerDer)] : [];
    return {
      kind: 'tls13',
      ticket: {
        ticket: bytesToHex(fields.ticket), resumptionMasterSecret: '', ticketNonce: '',
        resumptionPsk: bytesToHex(fields.masterKey),
        ticketAgeAdd: fields.ticketAgeAdd.toString(16).padStart(8, '0'),
        ...(peers.length > 0 ? { peerCertificates: peers } : {}),
        cipherSuite: cipherSuiteName(fields.cipherId) as CipherSuite,
        ticketLifetime: fields.ticketLifetimeHint, issuedAt: fields.time * 1000,
        maxEarlyDataSize: fields.maxEarlyData, verifyResult: fields.verifyResult,
        ...(fields.hostname !== undefined ? { serverName: fields.hostname } : {}),
        consumed: false,
      },
    };
  }
  const version = (Object.entries(LEGACY_VERSION_CODES).find(([, code]) => code === fields.protocolVersion)?.[0]) as LegacyVersion | undefined;
  const suite = legacySuiteByCode(fields.cipherId);
  if (version === undefined || suite === undefined) return { kind: 'unsupported', reason: 'the session uses a protocol version or cipher suite this client does not implement' };
  const state: LegacySessionState = {
    id: bytesToHex(fields.sessionId), version, suiteName: suite.name, master: bytesToHex(fields.masterKey),
    extendedMasterSecret: ((fields.flags ?? 0) & EXTENDED_MASTER_SECRET_FLAG) !== 0,
    createdAt: fields.time * 1000, lifetimeSeconds: fields.timeout,
  };
  const peers: X509Certificate[] = fields.peerDer ? [decodeCertificate(fields.peerDer)] : [];
  return {
    kind: 'legacy',
    session: {
      state, ticket: fields.ticket ? bytesToHex(fields.ticket) : null, verifyResult: fields.verifyResult,
      ...(peers.length > 0 ? { peerCertificates: peers } : {}),
    },
  };
}

export function legacyToSslSession(session: ResumableLegacySession, context: SessionWriteContext): SslSessionFields {
  const suite = legacySuiteByName(session.state.suiteName)!;
  return {
    protocolVersion: LEGACY_VERSION_CODES[session.state.version], cipherId: suite.code,
    sessionId: hexToBytes(session.state.id), masterKey: hexToBytes(session.state.master),
    time: Math.floor(session.state.createdAt / 1000), timeout: session.state.lifetimeSeconds,
    ...(context.peer ? { peerDer: encodeCertificate(context.peer) } : {}),
    verifyResult: context.verifyResult,
    ...(context.serverName !== undefined ? { hostname: context.serverName } : {}),
    ticketLifetimeHint: session.ticket ? session.state.lifetimeSeconds : 0,
    ...(session.ticket ? { ticket: hexToBytes(session.ticket) } : {}),
    ...(session.state.extendedMasterSecret ? { flags: EXTENDED_MASTER_SECRET_FLAG } : {}),
    ticketAgeAdd: 0, maxEarlyData: 0,
  };
}
