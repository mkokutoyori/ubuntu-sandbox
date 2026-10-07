import type { TcpSocket } from '@/network/tcp/TcpStack';
import type { TlsRecord } from './recordLayer';
import type { TlsServerSession } from './TlsServerSession';
import type { ClientCertPolicy } from './clientAuthPolicy';
import { encodeRecords, attachTlsRecordPump, bytesToBinaryString } from '../http/https/TlsRecordWire';
import { encryptApplicationData, decryptApplicationData } from '../http/https/ApplicationDataCipher';

export interface TlsServerChannelHandlers {
  onHandshakeComplete?(): void;
  onData(plaintext: Uint8Array): void;
  onRenegotiated?(): void;
}

export class TlsServerChannel {
  private clientSequence = 0;
  private serverSequence = 0;
  private readonly detach: () => void;

  constructor(
    private readonly socket: TcpSocket,
    private readonly tls: TlsServerSession,
    private readonly handlers: TlsServerChannelHandlers,
  ) {
    this.detach = attachTlsRecordPump(socket, (arrived) => this.receive(arrived));
  }

  get session(): TlsServerSession {
    return this.tls;
  }

  private emit(records: readonly TlsRecord[]): void {
    this.socket.write(bytesToBinaryString(encodeRecords([...records])));
  }

  private receive(arrived: readonly TlsRecord[]): void {
    let records = arrived;
    if (this.tls.result !== 'accept') {
      const reply = this.tls.handle(records);
      if (reply && reply.length > 0) this.emit(reply);
      if ((this.tls.result as string | null) !== 'accept') return;
      this.handlers.onHandshakeComplete?.();
      records = this.tls.takeTrailingRecords();
      if (records.length === 0) return;
    }
    if (this.tls.renegotiating) {
      this.continueRenegotiation(records);
      return;
    }
    const opened = decryptApplicationData(this.tls.clientTraffic(), this.clientSequence, records);
    this.clientSequence = opened.nextSeq;
    if (opened.renegotiation) {
      const answer = this.tls.handleRenegotiation(opened.renegotiation.records, opened.renegotiation.sequence, this.serverSequence);
      if (answer && answer.length > 0) {
        this.emit(answer);
        this.serverSequence += answer.length;
      }
    }
    if (opened.peerKeyUpdates) {
      const reply = this.tls.applyPeerKeyUpdates(opened.peerKeyUpdates, opened.peerRequestedKeyUpdate === true, this.serverSequence);
      if (reply.length > 0) {
        this.emit(reply);
        this.serverSequence = 0;
      }
    }
    if (opened.plaintext.length > 0) this.handlers.onData(opened.plaintext);
  }

  private continueRenegotiation(records: readonly TlsRecord[]): void {
    const answer = this.tls.handleRenegotiation(records, this.clientSequence, this.serverSequence);
    if (answer && answer.length > 0) this.emit(answer);
    if (this.tls.takeRenegotiationCompleted()) {
      this.clientSequence = 0;
      this.serverSequence = 0;
      this.handlers.onRenegotiated?.();
    }
  }

  write(bytes: Uint8Array): void {
    const sealed = encryptApplicationData(this.tls.serverTraffic(), this.serverSequence, bytes);
    this.serverSequence = sealed.nextSeq;
    this.emit(sealed.records);
  }

  requestRenegotiation(options: { readonly requestClientCertificate?: boolean; readonly clientCertPolicy?: ClientCertPolicy } = {}): boolean {
    const hello = this.tls.requestRenegotiation(this.serverSequence, options);
    if (hello === null) return false;
    this.serverSequence += hello.length;
    this.emit(hello);
    return true;
  }

  keyUpdate(requestUpdate: boolean): void {
    const records = this.tls.sendKeyUpdate(requestUpdate, this.serverSequence);
    this.serverSequence = 0;
    this.emit(records);
  }

  close(): void {
    this.detach();
    this.socket.close();
  }

  detachOnly(): void {
    this.detach();
  }
}
