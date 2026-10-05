import { utf8ToBytes } from '@/crypto/encoding';
import type { SshTransport } from '../transport/SshTransport';
import {
  SSH_DISCONNECT_PROTOCOL_ERROR, SSH_OPEN_CONNECT_FAILED, SSH_OPEN_RESOURCE_SHORTAGE, SSH_OPEN_UNKNOWN_CHANNEL_TYPE,
} from '../transport/SshMessageNumbers';
import {
  decodeConnectionMessage, encodeConnectionMessage, isConnectionMessageType,
  type ConnectionMessage,
} from './ConnectionMessages';

export const DEFAULT_CHANNEL_PACKET_SIZE = 32 * 1024;
export const DEFAULT_CHANNEL_WINDOW = 64 * DEFAULT_CHANNEL_PACKET_SIZE;

export interface SshConnectionOptions {
  readonly windowSize?: number;
  readonly maxPacket?: number;
}

export class SshOpenFailure extends Error {
  constructor(readonly reason: number, readonly description: string) {
    super(description);
    this.name = 'SshOpenFailure';
  }
}

export interface ChannelRequest {
  readonly name: string;
  readonly payload: Uint8Array;
  readonly wantReply: boolean;
  reply(success: boolean): void;
}

export interface GlobalRequest {
  readonly name: string;
  readonly payload: Uint8Array;
  readonly wantReply: boolean;
  reply(success: boolean, payload?: Uint8Array): void;
}

export interface IncomingChannel {
  readonly channelType: string;
  readonly payload: Uint8Array;
  accept(): ConnectionChannel;
  reject(reason: number, description: string): void;
}

const NO_PAYLOAD = new Uint8Array(0);

type ReplySlot = { done: boolean; success: boolean; payload: Uint8Array };

export class ConnectionChannel {
  private remoteId = -1;
  private remoteWindow = 0;
  private remoteMaxPacket = 0;
  private localWindow: number;
  private pending: Array<{ data: Uint8Array; extended: number | null }> = [];
  private released = false;
  private lostWithTransport = false;
  private flushing = false;
  private flushAgain = false;
  private sentEof = false;
  private sentClose = false;
  private receivedClose = false;
  private opened = false;
  private openFailure: SshOpenFailure | null = null;
  private readonly untilOpen: Array<() => void> = [];
  private readonly openHandlers: Array<(failure: SshOpenFailure | null) => void> = [];
  private readonly dataHandlers: Array<(data: Uint8Array) => void> = [];
  private readonly extendedHandlers: Array<(type: number, data: Uint8Array) => void> = [];
  private readonly eofHandlers: Array<() => void> = [];
  private readonly closeHandlers: Array<() => void> = [];
  private readonly requestHandlers: Array<(request: ChannelRequest) => void> = [];
  private readonly undeliveredRequests: ChannelRequest[] = [];
  private readonly requestReplies: Array<(success: boolean) => void> = [];
  private readonly replySlots: ReplySlot[] = [];
  private bufferedData: Uint8Array[] = [];
  private bufferedEof = false;

  constructor(
    readonly localId: number,
    readonly channelType: string,
    private readonly connection: SshConnection,
    private readonly windowMax: number,
    private readonly maxPacket: number,
  ) {
    this.localWindow = windowMax;
  }

  get isOpen(): boolean {
    return this.opened && !this.sentClose && !this.receivedClose;
  }

  get isOpening(): boolean {
    return !this.opened && this.openFailure === null && !this.released;
  }

  get failure(): SshOpenFailure | null {
    return this.openFailure;
  }

  whenOpened(handler: (failure: SshOpenFailure | null) => void): void {
    if (this.opened) handler(null);
    else if (this.openFailure !== null) handler(this.openFailure);
    else this.openHandlers.push(handler);
  }

  failed(failure: SshOpenFailure): void {
    this.openFailure = failure;
    this.untilOpen.length = 0;
    this.released = true;
    for (const handler of this.openHandlers.splice(0)) handler(failure);
    for (const handler of [...this.closeHandlers]) handler();
  }

  get remoteChannelId(): number {
    return this.remoteId;
  }

  get peerWindow(): number {
    return this.remoteWindow;
  }

  get ownWindow(): number {
    return this.localWindow;
  }

  confirmed(remoteId: number, window: number, maxPacket: number): void {
    this.remoteId = remoteId;
    this.remoteWindow = window;
    this.remoteMaxPacket = maxPacket;
    this.opened = true;
    for (const queued of this.untilOpen.splice(0)) queued();
    for (const handler of this.openHandlers.splice(0)) handler(null);
  }

  write(data: Uint8Array | string): void {
    this.enqueue(typeof data === 'string' ? utf8ToBytes(data) : data, null);
  }

  writeExtended(type: number, data: Uint8Array | string): void {
    this.enqueue(typeof data === 'string' ? utf8ToBytes(data) : data, type);
  }

  eof(): void {
    if (this.isOpening) {
      this.untilOpen.push(() => this.eof());
      return;
    }
    if (!this.isOpen || this.sentEof) return;
    this.flush();
    this.sentEof = true;
    this.connection.emit({ kind: 'eof', recipient: this.remoteId });
  }

  close(): void {
    if (this.isOpening) {
      this.untilOpen.push(() => this.close());
      return;
    }
    if (!this.opened || this.sentClose) return;
    this.sentClose = true;
    this.connection.emit({ kind: 'close', recipient: this.remoteId });
    this.finishIfBothClosed();
  }

  request(name: string, payload: Uint8Array = NO_PAYLOAD, wantReply = false): Promise<boolean> {
    if (this.isOpening) {
      return new Promise((resolve) => {
        this.untilOpen.push(() => { void this.request(name, payload, wantReply).then(resolve); });
      });
    }
    if (!this.isOpen) return Promise.resolve(false);
    const outcome = new Promise<boolean>((resolve) => {
      if (wantReply) this.requestReplies.push(resolve);
      else resolve(true);
    });
    this.connection.emit({ kind: 'channel-request', recipient: this.remoteId, name, wantReply, payload });
    return outcome;
  }

  onData(handler: (data: Uint8Array) => void): void {
    this.dataHandlers.push(handler);
    const held = this.bufferedData;
    this.bufferedData = [];
    for (const chunk of held) handler(chunk);
  }

  onExtendedData(handler: (type: number, data: Uint8Array) => void): void {
    this.extendedHandlers.push(handler);
  }

  onEof(handler: () => void): void {
    this.eofHandlers.push(handler);
    if (this.bufferedEof) handler();
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  onRequest(handler: (request: ChannelRequest) => void): void {
    this.requestHandlers.push(handler);
    for (const held of this.undeliveredRequests.splice(0)) handler(held);
  }

  receiveData(data: Uint8Array): void {
    if (data.length > this.localWindow) {
      this.connection.protocolError(`channel ${this.localId}: rcvd too much data ${data.length}, win ${this.localWindow}`);
      return;
    }
    this.localWindow -= data.length;
    if (this.dataHandlers.length === 0) this.bufferedData.push(data);
    else for (const handler of [...this.dataHandlers]) handler(data);
    this.replenishWindow();
  }

  receiveExtended(type: number, data: Uint8Array): void {
    if (data.length > this.localWindow) {
      this.connection.protocolError(`channel ${this.localId}: rcvd too much extended_data ${data.length}, win ${this.localWindow}`);
      return;
    }
    this.localWindow -= data.length;
    for (const handler of [...this.extendedHandlers]) handler(type, data);
    this.replenishWindow();
  }

  receiveEof(): void {
    this.bufferedEof = this.eofHandlers.length === 0;
    for (const handler of [...this.eofHandlers]) handler();
  }

  receiveClose(): void {
    this.receivedClose = true;
    if (!this.sentClose) {
      this.sentClose = true;
      this.connection.emit({ kind: 'close', recipient: this.remoteId });
    }
    this.finishIfBothClosed();
  }

  receiveWindowAdjust(bytes: number): void {
    this.remoteWindow = Math.min(this.remoteWindow + bytes, 0xffffffff);
    this.flush();
  }

  receiveRequest(name: string, wantReply: boolean, payload: Uint8Array): void {
    const slot: ReplySlot | null = wantReply ? { done: false, success: false, payload: NO_PAYLOAD } : null;
    if (slot) this.replySlots.push(slot);
    const request: ChannelRequest = {
      name, payload, wantReply,
      reply: (success) => {
        if (!slot || slot.done) return;
        slot.done = true;
        slot.success = success;
        this.flushReplies();
      },
    };
    if (this.requestHandlers.length === 0) {
      if (name === 'exit-status' || name === 'exit-signal' || name === 'signal' || name === 'window-change') {
        this.undeliveredRequests.push(request);
        return;
      }
      request.reply(false);
      return;
    }
    for (const handler of [...this.requestHandlers]) handler(request);
  }

  receiveReply(success: boolean): void {
    this.requestReplies.shift()?.(success);
  }

  private flushReplies(): void {
    while (this.replySlots.length > 0 && this.replySlots[0].done) {
      const slot = this.replySlots.shift()!;
      this.connection.emit(slot.success
        ? { kind: 'channel-success', recipient: this.remoteId }
        : { kind: 'channel-failure', recipient: this.remoteId });
    }
  }

  private enqueue(data: Uint8Array, extended: number | null): void {
    if (this.isOpening) {
      this.untilOpen.push(() => this.enqueue(data, extended));
      return;
    }
    if (!this.isOpen || this.sentEof || data.length === 0) return;
    this.pending.push({ data, extended });
    this.flush();
  }

  private flush(): void {
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    this.flushing = true;
    do {
      this.flushAgain = false;
      this.drainPending();
    } while (this.flushAgain);
    this.flushing = false;
  }

  private drainPending(): void {
    while (this.pending.length > 0 && this.remoteWindow > 0 && this.opened && !this.sentClose) {
      const head = this.pending[0];
      const size = Math.min(head.data.length, this.remoteWindow, this.remoteMaxPacket);
      if (size <= 0) return;
      const chunk = head.data.subarray(0, size);
      this.remoteWindow -= size;
      this.connection.emit(head.extended === null
        ? { kind: 'data', recipient: this.remoteId, data: chunk.slice() }
        : { kind: 'extended-data', recipient: this.remoteId, dataType: head.extended, data: chunk.slice() });
      if (size === head.data.length) this.pending.shift();
      else this.pending[0] = { data: head.data.subarray(size), extended: head.extended };
    }
  }

  private replenishWindow(): void {
    const consumed = this.windowMax - this.localWindow;
    if (consumed > 0 && (consumed > this.maxPacket * 3 || this.localWindow < this.windowMax / 2)) {
      this.localWindow = this.windowMax;
      this.connection.emit({ kind: 'window-adjust', recipient: this.remoteId, bytes: consumed });
    }
  }

  private finishIfBothClosed(): void {
    if (!this.sentClose || !this.receivedClose || this.released) return;
    this.released = true;
    this.connection.release(this.localId);
    for (const handler of [...this.closeHandlers]) handler();
  }

  get transportLost(): boolean {
    return this.lostWithTransport;
  }

  abort(): void {
    if (this.released) return;
    this.released = true;
    this.lostWithTransport = true;
    this.receivedClose = true;
    this.sentClose = true;
    for (const handler of [...this.closeHandlers]) handler();
  }
}

export class SshConnection {
  private readonly channels = new Map<number, ConnectionChannel>();
  private readonly opening = new Set<number>();
  private readonly openHandlers = new Map<string, (incoming: IncomingChannel) => void>();
  private globalHandler: ((request: GlobalRequest) => void) | null = null;
  private readonly globalReplies: Array<(success: boolean, payload: Uint8Array) => void> = [];
  private readonly globalSlots: Array<{ done: boolean; success: boolean; payload: Uint8Array }> = [];
  private readonly windowSize: number;
  private readonly maxPacket: number;
  private disposed = false;
  private readonly detach: () => void;

  constructor(private readonly transport: SshTransport, options: SshConnectionOptions = {}) {
    this.windowSize = options.windowSize ?? DEFAULT_CHANNEL_WINDOW;
    this.maxPacket = options.maxPacket ?? DEFAULT_CHANNEL_PACKET_SIZE;
    this.detach = transport.onMessage((payload) => this.receive(payload));
    transport.onClose(() => this.abortAll());
  }

  get channelCount(): number {
    return this.channels.size;
  }

  channel(localId: number): ConnectionChannel | undefined {
    return this.channels.get(localId);
  }

  onChannelOpen(channelType: string, handler: (incoming: IncomingChannel) => void): void {
    this.openHandlers.set(channelType, handler);
  }

  onGlobalRequest(handler: (request: GlobalRequest) => void): void {
    this.globalHandler = handler;
  }

  beginOpen(channelType: string, payload: Uint8Array = NO_PAYLOAD): ConnectionChannel {
    const id = this.allocateId();
    const channel = new ConnectionChannel(id ?? -1, channelType, this, this.windowSize, this.maxPacket);
    if (id === null) {
      channel.failed(new SshOpenFailure(SSH_OPEN_RESOURCE_SHORTAGE, 'no free channel id'));
      return channel;
    }
    this.channels.set(id, channel);
    this.opening.add(id);
    this.emit({
      kind: 'channel-open', channelType, senderChannel: id, initialWindow: this.windowSize,
      maxPacket: this.maxPacket, payload,
    });
    return channel;
  }

  openChannel(channelType: string, payload: Uint8Array = NO_PAYLOAD): Promise<ConnectionChannel> {
    const channel = this.beginOpen(channelType, payload);
    return new Promise((resolve, reject) => {
      channel.whenOpened((failure) => (failure === null ? resolve(channel) : reject(failure)));
    });
  }

  globalRequest(name: string, payload: Uint8Array = NO_PAYLOAD, wantReply = true): Promise<Uint8Array | null> {
    return new Promise<Uint8Array | null>((resolve) => {
      if (wantReply) this.sendGlobalRequest(name, payload, (success, reply) => resolve(success ? reply : null));
      else {
        this.sendGlobalRequest(name, payload);
        resolve(NO_PAYLOAD);
      }
    });
  }

  sendGlobalRequest(
    name: string, payload: Uint8Array = NO_PAYLOAD, onReply?: (success: boolean, payload: Uint8Array) => void,
  ): void {
    if (onReply !== undefined) this.globalReplies.push(onReply);
    this.emit({ kind: 'global-request', name, wantReply: onReply !== undefined, payload });
  }

  closeAll(): void {
    for (const channel of [...this.channels.values()]) channel.close();
  }

  dispose(): void {
    this.disposed = true;
    this.detach();
  }

  emit(message: ConnectionMessage): void {
    if (this.disposed || !this.transport.isOpen) return;
    this.transport.send(encodeConnectionMessage(message));
  }

  protocolError(description: string): void {
    this.disposed = true;
    this.transport.disconnect(SSH_DISCONNECT_PROTOCOL_ERROR, description);
  }

  release(localId: number): void {
    this.channels.delete(localId);
  }

  private abortAll(): void {
    this.disposed = true;
    for (const channel of [...this.channels.values()]) {
      if (channel.isOpening) channel.failed(new SshOpenFailure(SSH_OPEN_CONNECT_FAILED, 'connection closed'));
      else channel.abort();
    }
    this.channels.clear();
    this.opening.clear();
  }

  private allocateId(): number | null {
    for (let id = 0; id < 1 << 20; id++) if (!this.channels.has(id)) return id;
    return null;
  }

  private known(recipient: number, what: string): ConnectionChannel | null {
    const channel = this.channels.get(recipient);
    if (channel) return channel;
    this.protocolError(`${what} packet referred to nonexistent channel ${recipient}`);
    return null;
  }

  private receive(payload: Uint8Array): void {
    if (!isConnectionMessageType(payload[0])) return;
    const message = decodeConnectionMessage(payload);
    if (message === null) {
      this.protocolError(`invalid connection message type ${payload[0]}`);
      return;
    }
    switch (message.kind) {
      case 'global-request': return this.receiveGlobalRequest(message);
      case 'request-success': return void this.globalReplies.shift()?.(true, message.payload);
      case 'request-failure': return void this.globalReplies.shift()?.(false, NO_PAYLOAD);
      case 'channel-open': return this.receiveOpen(message);
      case 'open-confirmation': return this.receiveConfirmation(message);
      case 'open-failure': return this.receiveOpenFailure(message);
      case 'window-adjust': return this.known(message.recipient, 'window adjust')?.receiveWindowAdjust(message.bytes);
      case 'data': return this.known(message.recipient, 'data')?.receiveData(message.data);
      case 'extended-data':
        return this.known(message.recipient, 'extended data')?.receiveExtended(message.dataType, message.data);
      case 'eof': return this.known(message.recipient, 'eof')?.receiveEof();
      case 'close': return this.known(message.recipient, 'close')?.receiveClose();
      case 'channel-request':
        return this.known(message.recipient, 'request')?.receiveRequest(message.name, message.wantReply, message.payload);
      case 'channel-success': return this.known(message.recipient, 'success')?.receiveReply(true);
      case 'channel-failure': return this.known(message.recipient, 'failure')?.receiveReply(false);
    }
  }

  private receiveGlobalRequest(message: Extract<ConnectionMessage, { kind: 'global-request' }>): void {
    const slot = message.wantReply ? { done: false, success: false, payload: NO_PAYLOAD } : null;
    if (slot) this.globalSlots.push(slot);
    const flush = (): void => {
      while (this.globalSlots.length > 0 && this.globalSlots[0].done) {
        const head = this.globalSlots.shift()!;
        this.emit(head.success
          ? { kind: 'request-success', payload: head.payload }
          : { kind: 'request-failure' });
      }
    };
    const request: GlobalRequest = {
      name: message.name, payload: message.payload, wantReply: message.wantReply,
      reply: (success, payload = NO_PAYLOAD) => {
        if (!slot || slot.done) return;
        slot.done = true;
        slot.success = success;
        slot.payload = payload;
        flush();
      },
    };
    if (this.globalHandler === null) {
      request.reply(false);
      return;
    }
    this.globalHandler(request);
  }

  private receiveOpen(message: Extract<ConnectionMessage, { kind: 'channel-open' }>): void {
    const refuse = (reason: number, description: string): void => {
      this.emit({
        kind: 'open-failure', recipient: message.senderChannel, reason, description, language: '',
      });
    };
    const handler = this.openHandlers.get(message.channelType);
    if (!handler) {
      refuse(SSH_OPEN_UNKNOWN_CHANNEL_TYPE, 'unsupported channel type');
      return;
    }
    const id = this.allocateId();
    if (id === null) {
      refuse(SSH_OPEN_RESOURCE_SHORTAGE, 'no free channel id');
      return;
    }
    let decided = false;
    handler({
      channelType: message.channelType,
      payload: message.payload,
      accept: () => {
        const channel = new ConnectionChannel(id, message.channelType, this, this.windowSize, this.maxPacket);
        channel.confirmed(message.senderChannel, message.initialWindow, message.maxPacket);
        decided = true;
        this.channels.set(id, channel);
        this.emit({
          kind: 'open-confirmation', recipient: message.senderChannel, senderChannel: id,
          initialWindow: this.windowSize, maxPacket: this.maxPacket, payload: NO_PAYLOAD,
        });
        return channel;
      },
      reject: (reason, description) => {
        if (decided) return;
        decided = true;
        refuse(reason, description);
      },
    });
  }

  private receiveConfirmation(message: Extract<ConnectionMessage, { kind: 'open-confirmation' }>): void {
    const channel = this.channels.get(message.recipient);
    if (!channel || !this.opening.delete(message.recipient)) {
      this.protocolError(`open confirmation referred to nonexistent channel ${message.recipient}`);
      return;
    }
    channel.confirmed(message.senderChannel, message.initialWindow, message.maxPacket);
  }

  private receiveOpenFailure(message: Extract<ConnectionMessage, { kind: 'open-failure' }>): void {
    const channel = this.channels.get(message.recipient);
    if (!channel || !this.opening.delete(message.recipient)) {
      this.protocolError(`open failure referred to nonexistent channel ${message.recipient}`);
      return;
    }
    this.channels.delete(message.recipient);
    channel.failed(new SshOpenFailure(message.reason, message.description));
  }
}
