import type { TcpStack, TcpSocket } from '../../../tcp/TcpStack';
import { TlsServerSession } from '../../../tls/TlsServerSession';
import { CertificateAuthority } from '../../../pki/CertificateAuthority';
import {
  encodeRecords, decodeRecords, attachTlsRecordPump,
} from '../../../http/https/TlsRecordWire';
import {
  encryptApplicationData, decryptApplicationData,
} from '../../../http/https/ApplicationDataCipher';
import type { TlsRecord } from '../../../tls/recordLayer';
import type { X509Certificate } from '../../../pki/X509Certificate';
import type { LocalCertificate } from '../vpn/CertificateStore';
import type { UntrustedCertAction } from './UtmProfiles';
import { decodeHandshakeMessage } from '../../../tls/messages';
import { categoryOfDomain } from './UtmProfiles';
import { TcpInterceptor } from './TcpInterceptor';
import { openTlsUpstream, type TlsUpstream } from './TlsUpstream';
import { binaryStringToBytes, bytesToBinaryString } from '@/crypto/encoding';

export interface SslExemption {
  readonly type: string;
  readonly category?: number;
  readonly regex?: string;
  readonly addressName?: string;
}

export interface DeepInspectionProfile {
  readonly name: string;
  readonly ports: readonly number[];
  readonly caName: string;
  readonly untrustedCaName: string;
  readonly serverCertMode: string;
  readonly untrustedCert: UntrustedCertAction;
  readonly exemptions: readonly SslExemption[];
}

export function serverNameOf(records: readonly TlsRecord[]): string | null {
  for (const record of records) {
    if (record.contentType !== 'handshake') continue;
    try {
      const message = decodeHandshakeMessage(record.fragment);
      if (message.kind === 'client_hello') {
        return message.extensions.serverName ?? null;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function isExempt(
  profile: DeepInspectionProfile, serverName: string | null, destination: string,
  matchesAddress: (name: string, candidate: string) => boolean = () => false,
): boolean {
  for (const exemption of profile.exemptions) {
    switch (exemption.type) {
      case 'fortiguard-category':
        if (serverName !== null && exemption.category !== undefined
          && categoryOfDomain(serverName) === exemption.category) return true;
        break;
      case 'regex':
        if (serverName !== null && exemption.regex !== undefined) {
          try {
            if (new RegExp(exemption.regex).test(serverName)) return true;
          } catch { break; }
        }
        break;
      case 'address':
      case 'address6':
        if (exemption.addressName !== undefined
          && matchesAddress(exemption.addressName, destination)) return true;
        break;
      case 'wildcard-fqdn':
        if (serverName !== null && exemption.regex !== undefined
          && wildcardMatches(exemption.regex, serverName)) return true;
        break;
    }
  }
  return false;
}

function wildcardMatches(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try {
    return new RegExp(`^${escaped}$`, 'i').test(name);
  } catch {
    return false;
  }
}

export interface DeepInspectionDeps {
  readonly tcp: () => TcpStack;
  readonly localCertificate: (name: string) => LocalCertificate | undefined;
  readonly trustAnchors: () => readonly X509Certificate[];
  readonly matchesAddress: (name: string, candidate: string) => boolean;
  readonly now: () => number;
  readonly onIntercepted?: (server: string, subject: string, issuer: string) => void;
  readonly onUntrustedCertBlocked?: (server: string, subject: string, profile: string) => void;
  readonly claimPort?: (port: number) => void;
  readonly releasePort?: (port: number) => void;
}

const LEAF_VALIDITY_MS = 365 * 24 * 3600 * 1000;



export class SslDeepInspection extends TcpInterceptor<DeepInspectionProfile> {
  constructor(private readonly deps: DeepInspectionDeps) {
    super(deps, 'sslvpnd');
  }

  protected accept(socket: TcpSocket, profile: DeepInspectionProfile): void {
    this.intercept(socket, profile);
  }

  private intercept(clientSocket: TcpSocket, profile: DeepInspectionProfile): void {
    let started = false;
    let relay: ((records: readonly TlsRecord[], raw: string) => void) | null = null;

    attachTlsRecordPump(clientSocket, (records, raw) => {
      if (!started) {
        started = true;
        const serverName = serverNameOf(records);
        relay = isExempt(profile, serverName, clientSocket.localIp,
          (name, candidate) => this.deps.matchesAddress(name, candidate))
          ? this.passThrough(clientSocket)
          : this.terminate(clientSocket, profile);
      }
      relay?.(records, raw);
    });
  }

  private passThrough(
    clientSocket: TcpSocket,
  ): (records: readonly TlsRecord[], raw: string) => void {
    const upstream = this.deps.tcp().connect(clientSocket.localIp, clientSocket.localPort);
    if (!upstream || upstream.state !== 'established') {
      clientSocket.close();
      return () => undefined;
    }
    clientSocket.onClose(() => { upstream.close(); });

    return (_records, raw) => {
      let answer: string | null = null;
      const stop = upstream.onData((reply) => { answer = String(reply); });
      upstream.write(raw);
      stop();
      if (answer !== null) clientSocket.write(answer);
    };
  }

  private terminate(
    clientSocket: TcpSocket, profile: DeepInspectionProfile,
  ): (records: readonly TlsRecord[], raw: string) => void {
    const upstream = this.openUpstream(clientSocket.localIp, clientSocket.localPort);
    if (!upstream) { clientSocket.close(); return () => undefined; }

    if (!upstream.verified && profile.untrustedCert === 'block') {
      this.deps.onUntrustedCertBlocked?.(
        clientSocket.localIp, upstream.certificate.subject, profile.name);
      upstream.socket.close();
      clientSocket.close();
      return () => undefined;
    }

    const trusted = upstream.verified || profile.untrustedCert === 'ignore';
    const authorityName = trusted ? profile.caName : profile.untrustedCaName;
    const leaf = this.reSign(upstream.certificate, authorityName);
    if (!leaf) { upstream.socket.close(); clientSocket.close(); return () => undefined; }

    this.deps.onIntercepted?.(
      clientSocket.localIp, upstream.certificate.subject, leaf.cert.issuer);
    clientSocket.onClose(() => { upstream.socket.close(); });

    const server = new TlsServerSession({
      serverCert: leaf.cert, serverPrivateKey: leaf.privateKey, alpnProtocols: ['http/1.1'],
    });

    let clientSeq = 0;
    let serverSeq = 0;
    let upstreamClientSeq = 0;
    let upstreamServerSeq = 0;
    let handshaking = true;

    return (records) => {
      if (handshaking) {
        const flight = server.handle(records);
        if (flight && flight.length > 0) {
          clientSocket.write(bytesToBinaryString(encodeRecords(flight)));
        }
        if (server.result !== null) handshaking = false;
        return;
      }
      if (server.result !== 'accept') return;

      const { plaintext, nextSeq } = decryptApplicationData(
        server.clientTraffic(), clientSeq, records);
      clientSeq = nextSeq;

      const forwarded = encryptApplicationData(
        upstream.session.clientTraffic(), upstreamClientSeq, plaintext);
      upstreamClientSeq = forwarded.nextSeq;

      let answer: TlsRecord[] | null = null;
      const stop = upstream.socket.onData((reply) => {
        answer = decodeRecords(binaryStringToBytes(String(reply)));
      });
      upstream.socket.write(bytesToBinaryString(encodeRecords(forwarded.records)));
      stop();
      if (!answer) return;

      const decoded = decryptApplicationData(
        upstream.session.serverTraffic(), upstreamServerSeq, answer);
      upstreamServerSeq = decoded.nextSeq;

      const resealed = encryptApplicationData(
        server.serverTraffic(), serverSeq, decoded.plaintext);
      serverSeq = resealed.nextSeq;
      clientSocket.write(bytesToBinaryString(encodeRecords(resealed.records)));
    };
  }

  private openUpstream(ip: string, port: number): TlsUpstream | null {
    return openTlsUpstream(this.deps.tcp(), this.deps.trustAnchors(), ip, port);
  }

  private reSign(server: X509Certificate, authorityName: string) {
    const entry = this.deps.localCertificate(authorityName);
    if (!entry) return null;
    const authority = CertificateAuthority.fromKeyPair(entry.certificate, entry.privateKey);
    const now = this.deps.now();
    return authority.issueCertificate({
      subject: server.subject,
      notBefore: now - 60_000,
      notAfter: now + LEAF_VALIDITY_MS,
      subjectAltNames: server.extensions?.subjectAltName
        ? [...server.extensions.subjectAltName] : undefined,
      extKeyUsage: ['serverAuth'],
    });
  }
}
