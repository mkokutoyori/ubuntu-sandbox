import type { TcpSocket } from '@/network/tcp/TcpStack';
import { bytesToFileText } from '@/crypto/encoding';
import type { TlsRecord } from './recordLayer';
import type { TlsClientSession } from './TlsClientSession';
import { encodeRecords, decodeRecords, bytesToBinaryString, binaryStringToBytes } from '../http/https/TlsRecordWire';
import { encryptApplicationData, decryptApplicationData } from '../http/https/ApplicationDataCipher';

export class TlsClientChannel {
  private clientSequence = 0;
  private serverSequence = 0;
  private inbox = new Uint8Array(0);
  private collecting = false;
  private pushHandler: ((text: string) => void) | null = null;

  constructor(private readonly socket: TcpSocket, private readonly session: TlsClientSession) {
    socket.onData((data) => {
      try { this.receive(data); } catch { return; }
    });
  }

  onPush(handler: (text: string) => void): void {
    this.pushHandler = handler;
  }

  private write(records: readonly TlsRecord[]): void {
    this.socket.write(bytesToBinaryString(encodeRecords([...records])));
  }

  private receive(data: unknown): void {
    this.receiveRecords(decodeRecords(binaryStringToBytes(String(data))));
  }

  receiveRecords(records: readonly TlsRecord[]): void {
    if (this.session.renegotiating) {
      this.continueRenegotiation(records);
      return;
    }
    const opened = decryptApplicationData(this.session.serverTraffic(), this.serverSequence, records);
    this.serverSequence = opened.nextSeq;
    if (opened.renegotiation) this.continueRenegotiation(opened.renegotiation.records, opened.renegotiation.sequence);
    if (opened.peerKeyUpdates) {
      const answer = this.session.applyPeerKeyUpdates(opened.peerKeyUpdates, opened.peerRequestedKeyUpdate === true, this.clientSequence);
      if (answer.length > 0) { this.write(answer); this.clientSequence = 0; }
    }
    if (opened.plaintext.length === 0) return;
    if (this.collecting || this.pushHandler === null) {
      const joined = new Uint8Array(this.inbox.length + opened.plaintext.length);
      joined.set(this.inbox); joined.set(opened.plaintext, this.inbox.length);
      this.inbox = joined;
    } else {
      this.pushHandler(bytesToFileText(opened.plaintext));
    }
  }

  private continueRenegotiation(records: readonly TlsRecord[], receiveSequence = this.serverSequence): void {
    const answer = this.session.handleRenegotiation(records, receiveSequence, this.clientSequence);
    if (answer && answer.length > 0) this.write(answer);
    if (this.session.takeRenegotiationCompleted()) { this.clientSequence = 0; this.serverSequence = 0; }
  }

  private collect(act: () => void): Uint8Array {
    this.inbox = new Uint8Array(0);
    this.collecting = true;
    try { act(); } finally { this.collecting = false; }
    const reply = this.inbox;
    this.inbox = new Uint8Array(0);
    return reply;
  }

  exchange(payload: Uint8Array): Uint8Array {
    return this.collect(() => {
      const sealed = encryptApplicationData(this.session.clientTraffic(), this.clientSequence, payload);
      this.clientSequence = sealed.nextSeq;
      this.write(sealed.records);
    });
  }

  async exchangeAsync(payload: Uint8Array, microtaskBudget: number): Promise<Uint8Array> {
    this.inbox = new Uint8Array(0);
    this.collecting = true;
    try {
      const sealed = encryptApplicationData(this.session.clientTraffic(), this.clientSequence, payload);
      this.clientSequence = sealed.nextSeq;
      this.write(sealed.records);
      for (let tour = 0; this.inbox.length === 0 && tour < microtaskBudget; tour++) await Promise.resolve();
    } finally {
      this.collecting = false;
    }
    const reply = this.inbox;
    this.inbox = new Uint8Array(0);
    return reply;
  }

  takeBuffered(): Uint8Array {
    const taken = this.inbox;
    this.inbox = new Uint8Array(0);
    return taken;
  }

  resendRejectedEarlyData(): Uint8Array | null {
    const rejected = this.session.rejectedEarlyData;
    return rejected === null ? null : this.exchange(rejected);
  }

  renegotiate(): boolean {
    const hello = this.session.startRenegotiation(this.serverSequence, this.clientSequence);
    if (hello === null) return false;
    this.clientSequence += hello.length;
    this.collect(() => this.write(hello));
    return !this.session.renegotiating && this.session.renegotiations > 0;
  }

  keyUpdate(requestUpdate: boolean): void {
    const records = this.session.sendKeyUpdate(requestUpdate, this.clientSequence);
    this.clientSequence = 0;
    this.collect(() => this.write(records));
  }

  close(): void {
    this.socket.close();
  }
}
