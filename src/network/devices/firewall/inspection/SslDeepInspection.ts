import { IP_PROTO_TCP, type IPv4Packet } from '../../../core/types';
import type { TcpStack, TcpListener, TcpSocket } from '../../../tcp/TcpStack';
import { TlsServerSession } from '../../../tls/TlsServerSession';
import { TlsClientSession } from '../../../tls/TlsClientSession';
import { CertificateAuthority } from '../../../pki/CertificateAuthority';
import { CertificateVerifier } from '../../../pki/CertificateVerifier';
import {
  encodeRecords, decodeRecords, runTlsHandshakeOverSocket,
} from '../../../http/https/TlsRecordWire';
import {
  encryptApplicationData, decryptApplicationData,
} from '../../../http/https/ApplicationDataCipher';
import type { TlsRecord } from '../../../tls/recordLayer';
import type { X509Certificate } from '../../../pki/X509Certificate';
import type { LocalCertificate } from '../vpn/CertificateStore';
import { decodeHandshakeMessage } from '../../../tls/messages';
import { categoryOfDomain } from './UtmProfiles';

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
  readonly claimPort?: (port: number) => void;
  readonly releasePort?: (port: number) => void;
}

const LEAF_VALIDITY_MS = 365 * 24 * 3600 * 1000;

function bytesToBinaryString(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

function binaryStringToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

function flowKey(packet: IPv4Packet): string | null {
  const segment = packet.payload as {
    type?: string; sourcePort?: number; destinationPort?: number;
  } | undefined;
  if (segment?.type !== 'tcp') return null;
  return `${packet.sourceIP.toString()}:${segment.sourcePort}`
    + `>${packet.destinationIP.toString()}:${segment.destinationPort}`;
}

function destinationPort(packet: IPv4Packet): number | null {
  if (packet.protocol !== IP_PROTO_TCP) return null;
  const segment = packet.payload as { type?: string; destinationPort?: number } | undefined;
  return segment?.type === 'tcp' ? segment.destinationPort ?? null : null;
}

export class SslDeepInspection {
  private readonly listeners = new Map<number, TcpListener>();
  private readonly captured = new Set<string>();
  private readonly pending = new Map<string, DeepInspectionProfile>();

  constructor(private readonly deps: DeepInspectionDeps) {}

  owns(packet: IPv4Packet): boolean {
    const key = flowKey(packet);
    return key !== null && this.captured.has(key);
  }

  resume(iface: string, packet: IPv4Packet): boolean {
    if (!this.owns(packet)) return false;
    return this.deps.tcp().handleIp(iface, packet.sourceIP, packet);
  }

  capture(iface: string, packet: IPv4Packet, profile: DeepInspectionProfile): boolean {
    const port = destinationPort(packet);
    if (port === null || !profile.ports.includes(port)) return false;

    this.arm(port);
    const key = flowKey(packet);
    if (key === null) return false;
    this.captured.add(key);
    this.pending.set(
      `${packet.destinationIP.toString()}:${port}|${packet.sourceIP.toString()}`, profile);
    return this.deps.tcp().handleIp(iface, packet.sourceIP, packet);
  }

  isArmed(port: number): boolean { return this.listeners.has(port); }

  disarm(): void {
    for (const port of [...this.listeners.keys()]) {
      this.deps.tcp().closeListener(port);
      this.listeners.delete(port);
      this.deps.releasePort?.(port);
    }
    this.captured.clear();
    this.pending.clear();
  }

  private arm(port: number): void {
    if (this.listeners.has(port)) return;
    this.deps.claimPort?.(port);
    const listener = this.deps.tcp().listen(port, {
      onAccept: (socket) => { this.intercept(socket); },
      identity: { processName: 'sslvpnd' },
    });
    if (listener) this.listeners.set(port, listener);
  }

  private profileOf(socket: TcpSocket): DeepInspectionProfile | undefined {
    return this.pending.get(`${socket.localIp}:${socket.localPort}|${socket.remoteIp}`);
  }

  private intercept(clientSocket: TcpSocket): void {
    const profile = this.profileOf(clientSocket);
    if (!profile) { clientSocket.close(); return; }

    let started = false;
    let relay: ((records: readonly TlsRecord[], raw: string) => void) | null = null;

    clientSocket.onData((data) => {
      const raw = String(data);
      const records = decodeRecords(binaryStringToBytes(raw));
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

    clientSocket.onClose(() => {
      this.captured.delete(
        `${clientSocket.remoteIp}:${clientSocket.remotePort}`
        + `>${clientSocket.localIp}:${clientSocket.localPort}`);
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

    const authorityName = upstream.verified ? profile.caName : profile.untrustedCaName;
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
        server.clientApplicationTrafficSecret!, clientSeq, records);
      clientSeq = nextSeq;

      const forwarded = encryptApplicationData(
        upstream.session.clientApplicationTrafficSecret!, upstreamClientSeq, plaintext);
      upstreamClientSeq = forwarded.nextSeq;

      let answer: TlsRecord[] | null = null;
      const stop = upstream.socket.onData((reply) => {
        answer = decodeRecords(binaryStringToBytes(String(reply)));
      });
      upstream.socket.write(bytesToBinaryString(encodeRecords(forwarded.records)));
      stop();
      if (!answer) return;

      const decoded = decryptApplicationData(
        upstream.session.serverApplicationTrafficSecret!, upstreamServerSeq, answer);
      upstreamServerSeq = decoded.nextSeq;

      const resealed = encryptApplicationData(
        server.serverApplicationTrafficSecret!, serverSeq, decoded.plaintext);
      serverSeq = resealed.nextSeq;
      clientSocket.write(bytesToBinaryString(encodeRecords(resealed.records)));
    };
  }

  private openUpstream(ip: string, port: number): {
    socket: TcpSocket; session: TlsClientSession;
    certificate: X509Certificate; verified: boolean;
  } | null {
    const socket = this.deps.tcp().connect(ip, port);
    if (!socket || socket.state !== 'established') return null;

    const session = new TlsClientSession({
      verifier: new CertificateVerifier({ trustAnchors: this.deps.trustAnchors() }),
      alpn: ['http/1.1'],
    });
    runTlsHandshakeOverSocket(socket, session);

    const certificate = session.peerCertificate;
    if (!certificate) { socket.close(); return null; }
    return { socket, session, certificate, verified: session.result === 'success' };
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
