import type { TcpSocket } from '@/network/tcp/TcpStack';
import { decodePdu, encodePdu, LdpDecodeError, LDP_MINIMUM_PDU_LENGTH } from './LdpCodec';
import { LdpIdentifier } from './LdpIdentifier';
import {
  LDP_DEFAULT_MAX_PDU_LENGTH, LDP_VERSION, StatusCode, isFatalStatus,
  type AdvertisementMode, type InitializationMessage, type LdpMessage, type LdpPdu,
} from './LdpMessages';
import type { IPAddress } from '@/network/core/types';

export type LdpSessionState = 'non-existent' | 'initialized' | 'open-sent' | 'open-rec' | 'operational';
export type LdpRole = 'active' | 'passive';

export interface LdpSessionParameters {
  readonly keepAliveTimeSeconds: number;
  readonly advertisementMode: AdvertisementMode;
  readonly loopDetection: boolean;
  readonly pathVectorLimit?: number;
  readonly maxPduLength: number;
}

export interface LdpSessionOwner {
  readonly localId: LdpIdentifier;
  readonly parameters: LdpSessionParameters;
  hasHelloAdjacency(peer: LdpIdentifier): boolean;
  scheduleTimeout(callback: () => void, delayMs: number): number;
  cancelTimeout(handle: number): void;
  nextMessageId(): number;
  nowMs(): number;
  sessionOperational(session: LdpSession): void;
  sessionMessage(session: LdpSession, message: LdpMessage): void;
  sessionClosed(session: LdpSession, reason: string, rejected: boolean): void;
}

export class LdpSession {
  state: LdpSessionState = 'non-existent';
  peer: LdpIdentifier | null;
  negotiated: LdpSessionParameters | null = null;
  readonly peerAddresses = new Map<string, IPAddress>();
  messagesSent = 0;
  messagesReceived = 0;
  operationalSinceMs: number | null = null;
  private buffer = new Uint8Array(0);
  private keepAliveTimer: number | null = null;
  private holdTimer: number | null = null;
  private closed = false;
  private closingReason: string | null = null;

  constructor(
    private readonly owner: LdpSessionOwner,
    readonly socket: TcpSocket,
    readonly role: LdpRole,
    peer: LdpIdentifier | null,
    readonly transportPeer: string,
  ) {
    this.peer = peer;
    socket.onData((chunk) => { if (chunk instanceof Uint8Array) this.receive(chunk); });
    socket.onClose(() => this.terminate(this.closingReason ?? 'transport closed', false));
  }

  start(): void {
    this.state = 'initialized';
    if (this.role === 'active' && this.peer) {
      this.state = 'open-sent';
      this.sendInitialization();
    }
  }

  send(messages: readonly LdpMessage[]): void {
    if (this.closed) return;
    const pdu: LdpPdu = { version: LDP_VERSION, sender: this.owner.localId, messages };
    this.messagesSent += messages.length;
    this.socket.send(encodePdu(pdu));
    this.armKeepAlive();
  }

  notify(statusCode: number, referenced?: LdpMessage): void {
    this.send([{
      kind: 'notification', id: this.owner.nextMessageId(), statusCode, forward: false,
      referencedMessageId: referenced?.id ?? 0, referencedMessageType: 0,
    }]);
  }

  shutdown(): void {
    if (this.closed) return;
    this.closingReason = 'shutdown';
    this.notify(StatusCode.Shutdown);
    this.terminate('shutdown', false);
  }

  private sendInitialization(): void {
    const parameters = this.owner.parameters;
    const message: InitializationMessage = {
      kind: 'initialization', id: this.owner.nextMessageId(), protocolVersion: LDP_VERSION,
      keepAliveTimeSeconds: parameters.keepAliveTimeSeconds, advertisementMode: parameters.advertisementMode,
      loopDetection: parameters.loopDetection, pathVectorLimit: parameters.loopDetection ? parameters.pathVectorLimit ?? 0 : 0, maxPduLength: parameters.maxPduLength,
      receiver: this.peer as LdpIdentifier,
    };
    this.send([message]);
  }

  private receive(chunk: Uint8Array): void {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer, 0);
    joined.set(chunk, this.buffer.length);
    this.buffer = joined;
    for (;;) {
      if (this.closed || this.buffer.length < 4) return;
      const length = (this.buffer[2] << 8) | this.buffer[3];
      if (this.buffer.length < 4 + length) return;
      const frame = this.buffer.slice(0, 4 + length);
      this.buffer = this.buffer.slice(4 + length);
      this.process(frame);
    }
  }

  private process(frame: Uint8Array): void {
    const maxPdu = this.negotiated?.maxPduLength ?? LDP_DEFAULT_MAX_PDU_LENGTH;
    let pdu: LdpPdu;
    try {
      pdu = decodePdu(frame, maxPdu);
    } catch (error) {
      const code = error instanceof LdpDecodeError ? error.statusCode : StatusCode.InternalError;
      this.notify(code);
      if (error instanceof LdpDecodeError && !this.fatalForSession(code)) return;
      this.terminate('malformed PDU', false);
      return;
    }
    this.restartHold();
    this.messagesReceived += pdu.messages.length;
    if (this.peer === null) this.peer = pdu.sender;
    else if (!this.peer.equals(pdu.sender)) {
      this.notify(StatusCode.BadLdpIdentifier);
      this.terminate('bad LDP identifier', false);
      return;
    }
    for (const message of pdu.messages) {
      if (this.closed) return;
      this.dispatch(message);
    }
  }

  private fatalForSession(code: number): boolean {
    return isFatalStatus(code);
  }

  private dispatch(message: LdpMessage): void {
    if (message.kind === 'notification') {
      if (isFatalStatus(message.statusCode)) {
        this.terminate(`peer notification ${message.statusCode.toString(16)}`, this.state !== 'operational');
      } else if (this.state === 'operational') {
        this.owner.sessionMessage(this, message);
      }
      return;
    }
    switch (this.state) {
      case 'initialized': this.inInitialized(message); return;
      case 'open-sent': this.inOpenSent(message); return;
      case 'open-rec': this.inOpenRec(message); return;
      case 'operational': this.inOperational(message); return;
      default: return;
    }
  }

  private inInitialized(message: LdpMessage): void {
    if (this.role === 'passive' && message.kind === 'initialization') {
      if (this.peer === null || !this.owner.hasHelloAdjacency(this.peer)) {
        this.notify(StatusCode.SessionRejectedNoHello, message);
        this.terminate('no hello adjacency', true);
        return;
      }
      const verdict = this.negotiate(message);
      if (verdict !== null) {
        this.notify(verdict, message);
        this.terminate('parameters rejected', true);
        return;
      }
      this.state = 'open-rec';
      this.sendInitializationAnswer();
      this.send([{ kind: 'keepalive', id: this.owner.nextMessageId() }]);
      return;
    }
    this.notify(StatusCode.MissingMessageParameters, message);
    this.terminate('unexpected message in INITIALIZED', true);
  }

  private sendInitializationAnswer(): void {
    const parameters = this.owner.parameters;
    this.send([{
      kind: 'initialization', id: this.owner.nextMessageId(), protocolVersion: LDP_VERSION,
      keepAliveTimeSeconds: parameters.keepAliveTimeSeconds, advertisementMode: parameters.advertisementMode,
      loopDetection: parameters.loopDetection, pathVectorLimit: parameters.loopDetection ? parameters.pathVectorLimit ?? 0 : 0, maxPduLength: parameters.maxPduLength,
      receiver: this.peer as LdpIdentifier,
    }]);
  }

  private inOpenSent(message: LdpMessage): void {
    if (message.kind === 'initialization') {
      const verdict = this.negotiate(message);
      if (verdict !== null) {
        this.notify(verdict, message);
        this.terminate('parameters rejected', true);
        return;
      }
      this.state = 'open-rec';
      this.send([{ kind: 'keepalive', id: this.owner.nextMessageId() }]);
      return;
    }
    this.notify(StatusCode.MissingMessageParameters, message);
    this.terminate('unexpected message in OPENSENT', true);
  }

  private inOpenRec(message: LdpMessage): void {
    if (message.kind === 'keepalive') {
      this.state = 'operational';
      this.operationalSinceMs = this.owner.nowMs();
      this.armKeepAlive();
      this.restartHold();
      this.owner.sessionOperational(this);
      return;
    }
    this.notify(StatusCode.MissingMessageParameters, message);
    this.terminate('unexpected message in OPENREC', true);
  }

  private inOperational(message: LdpMessage): void {
    if (message.kind === 'keepalive') return;
    if (message.kind === 'unknown') {
      if (!message.unknownBit) this.notify(StatusCode.UnknownMessageType, message);
      return;
    }
    this.owner.sessionMessage(this, message);
  }

  private negotiate(proposal: InitializationMessage): number | null {
    const local = this.owner.parameters;
    if (proposal.protocolVersion !== LDP_VERSION) return StatusCode.BadProtocolVersion;
    if (proposal.keepAliveTimeSeconds === 0) return StatusCode.SessionRejectedBadKeepAliveTime;
    if (proposal.maxPduLength !== 0 && proposal.maxPduLength < LDP_MINIMUM_PDU_LENGTH) return StatusCode.SessionRejectedMaxPduLength;
    if (!this.peer || !proposal.receiver.equals(this.owner.localId)) return StatusCode.SessionRejectedNoHello;
    if (proposal.advertisementMode !== local.advertisementMode && local.advertisementMode === 'on-demand') {
      return StatusCode.SessionRejectedAdvertisementMode;
    }
    this.negotiated = {
      keepAliveTimeSeconds: Math.min(local.keepAliveTimeSeconds, proposal.keepAliveTimeSeconds),
      advertisementMode: 'unsolicited',
      loopDetection: local.loopDetection && proposal.loopDetection,
      pathVectorLimit: local.pathVectorLimit ?? 0,
      maxPduLength: proposal.maxPduLength === 0 ? local.maxPduLength : Math.min(local.maxPduLength, proposal.maxPduLength),
    };
    return null;
  }

  private armKeepAlive(): void {
    if (this.state !== 'operational' || !this.negotiated) return;
    if (this.keepAliveTimer !== null) this.owner.cancelTimeout(this.keepAliveTimer);
    const interval = Math.max(1, Math.floor(this.negotiated.keepAliveTimeSeconds / 3)) * 1000;
    this.keepAliveTimer = this.owner.scheduleTimeout(() => {
      this.keepAliveTimer = null;
      this.send([{ kind: 'keepalive', id: this.owner.nextMessageId() }]);
    }, interval);
  }

  private restartHold(): void {
    if (!this.negotiated) return;
    if (this.holdTimer !== null) this.owner.cancelTimeout(this.holdTimer);
    this.holdTimer = this.owner.scheduleTimeout(() => {
      this.holdTimer = null;
      this.closingReason = 'keepalive timer expired';
      this.notify(StatusCode.KeepAliveTimerExpired);
      this.terminate('keepalive timer expired', false);
    }, this.negotiated.keepAliveTimeSeconds * 1000);
  }

  terminate(reason: string, rejected: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.state = 'non-existent';
    if (this.keepAliveTimer !== null) this.owner.cancelTimeout(this.keepAliveTimer);
    if (this.holdTimer !== null) this.owner.cancelTimeout(this.holdTimer);
    this.keepAliveTimer = null;
    this.holdTimer = null;
    this.socket.close();
    this.owner.sessionClosed(this, reason, rejected);
  }

  isClosed(): boolean {
    return this.closed;
  }
}
