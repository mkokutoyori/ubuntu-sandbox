import type { TcpStack, TcpSocket } from '../../../tcp/TcpStack';
import { TlsServerSession } from '../../../tls/TlsServerSession';
import { encodeRecords, decodeRecords, attachTlsRecordPump } from '../../../http/https/TlsRecordWire';
import { encryptApplicationData, decryptApplicationData } from '../../../http/https/ApplicationDataCipher';
import type { TlsRecord } from '../../../tls/recordLayer';
import type { X509Certificate } from '../../../pki/X509Certificate';
import type { LocalCertificate } from '../vpn/CertificateStore';
import type { RealServerChoice } from '../nat/RealServerPool';
import { binaryStringToBytes, bytesToBinaryString } from '@/crypto/encoding';
import { TcpInterceptor } from './TcpInterceptor';
import { openTlsUpstream } from './TlsUpstream';

export type SslOffloadMode = 'half' | 'full';

export interface SslOffloadVip {
  readonly name: string;
  readonly ports: readonly number[];
  readonly mode: SslOffloadMode;
  readonly certificate: string;
  readonly pickServer: () => RealServerChoice | undefined;
}

export interface SslOffloadDeps {
  readonly tcp: () => TcpStack;
  readonly localCertificate: (name: string) => LocalCertificate | undefined;
  readonly trustAnchors: () => readonly X509Certificate[];
  readonly claimPort?: (port: number) => void;
  readonly releasePort?: (port: number) => void;
  readonly onOffloaded?: (vip: string, server: string) => void;
}

interface Backend {
  readonly socket: TcpSocket;
  send(plaintext: Uint8Array): Uint8Array;
}

export class SslOffload extends TcpInterceptor<SslOffloadVip> {
  constructor(private readonly deps: SslOffloadDeps) {
    super(deps, 'sslvpnd');
  }

  protected accept(clientSocket: TcpSocket, vip: SslOffloadVip): void {
    const certificate = this.deps.localCertificate(vip.certificate);
    if (!certificate) { clientSocket.close(); return; }

    let relay: ((records: readonly TlsRecord[]) => void) | null = null;
    attachTlsRecordPump(clientSocket, (records) => {
      relay ??= this.terminate(clientSocket, vip, certificate);
      relay(records);
    });
  }

  private terminate(
    clientSocket: TcpSocket, vip: SslOffloadVip, certificate: LocalCertificate,
  ): (records: readonly TlsRecord[]) => void {
    const server = new TlsServerSession({
      serverCert: certificate.certificate,
      serverPrivateKey: certificate.privateKey,
      alpnProtocols: ['http/1.1'],
    });

    let backend: Backend | null = null;
    let clientSeq = 0;
    let serverSeq = 0;
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
      if (plaintext.length === 0) return;

      if (!backend) {
        backend = this.openBackend(vip);
        if (!backend) { clientSocket.close(); return; }
        const opened = backend;
        clientSocket.onClose(() => { opened.socket.close(); });
      }
      const reply = backend.send(plaintext);
      if (reply.length === 0) return;

      const resealed = encryptApplicationData(server.serverTraffic(), serverSeq, reply);
      serverSeq = resealed.nextSeq;
      clientSocket.write(bytesToBinaryString(encodeRecords(resealed.records)));
    };
  }

  private openBackend(vip: SslOffloadVip): Backend | null {
    const choice = vip.pickServer();
    if (!choice) return null;

    this.deps.onOffloaded?.(vip.name, `${choice.address}:${choice.port}`);
    return vip.mode === 'full'
      ? this.openEncrypted(choice)
      : this.openPlain(choice);
  }

  private openPlain(choice: RealServerChoice): Backend | null {
    const socket = this.deps.tcp().connect(choice.address, choice.port);
    if (!socket || socket.state !== 'established') return null;

    return {
      socket,
      send: (plaintext) => {
        let answer = '';
        const stop = socket.onData((chunk) => { answer += String(chunk); });
        socket.write(bytesToBinaryString(plaintext));
        stop();
        return binaryStringToBytes(answer);
      },
    };
  }

  private openEncrypted(choice: RealServerChoice): Backend | null {
    const upstream = openTlsUpstream(
      this.deps.tcp(), this.deps.trustAnchors(), choice.address, choice.port);
    if (!upstream) return null;

    let sent = 0;
    let received = 0;
    return {
      socket: upstream.socket,
      send: (plaintext) => {
        const sealed = encryptApplicationData(upstream.session.clientTraffic(), sent, plaintext);
        sent = sealed.nextSeq;

        let answer: TlsRecord[] = [];
        const stop = upstream.socket.onData((chunk) => {
          answer = [...answer, ...decodeRecords(binaryStringToBytes(String(chunk)))];
        });
        upstream.socket.write(bytesToBinaryString(encodeRecords(sealed.records)));
        stop();
        if (answer.length === 0) return new Uint8Array(0);

        const opened = decryptApplicationData(upstream.session.serverTraffic(), received, answer);
        received = opened.nextSeq;
        return opened.plaintext;
      },
    };
  }
}
