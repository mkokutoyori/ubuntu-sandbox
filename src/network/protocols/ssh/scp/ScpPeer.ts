import { binaryStringToBytes, bytesToBinaryString } from '@/crypto/encoding';
import { ScpByteQueue } from './ScpByteQueue';
import { SCP_ACK } from './ScpWireCodec';

export interface ScpTransport {
  write(data: Uint8Array | string): void;
  eof(): void;
  close(): void;
  onData(handler: (data: Uint8Array) => void): void;
  onEof(handler: () => void): void;
  onClose(handler: () => void): void;
  onRequest(handler: (request: { readonly name: string; readonly payload: Uint8Array }) => void): void;
}

class MemoryEnd implements ScpTransport {
  other!: MemoryEnd;
  private readonly dataHandlers: Array<(data: Uint8Array) => void> = [];
  private readonly eofHandlers: Array<() => void> = [];
  private readonly closeHandlers: Array<() => void> = [];
  private held: Uint8Array[] = [];
  private closed = false;

  write(data: Uint8Array | string): void {
    const bytes = typeof data === 'string' ? binaryStringToBytes(data) : data;
    this.other.deliver(bytes);
  }

  eof(): void {
    for (const handler of this.other.eofHandlers) handler();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler();
    this.other.close();
  }

  onData(handler: (data: Uint8Array) => void): void {
    this.dataHandlers.push(handler);
    for (const bytes of this.held.splice(0)) handler(bytes);
  }

  onEof(handler: () => void): void {
    this.eofHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  onRequest(): void {
    return undefined;
  }

  private deliver(bytes: Uint8Array): void {
    if (this.dataHandlers.length === 0) this.held.push(bytes);
    else for (const handler of this.dataHandlers) handler(bytes);
  }
}

export function memoryPipe(): [ScpTransport, ScpTransport] {
  const left = new MemoryEnd();
  const right = new MemoryEnd();
  left.other = right;
  right.other = left;
  return [left, right];
}

export type ScpResponse =
  | { readonly kind: 'ok' }
  | { readonly kind: 'warning'; readonly text: string }
  | { readonly kind: 'fatal'; readonly text: string }
  | { readonly kind: 'foreign'; readonly text: string }
  | { readonly kind: 'eof' };

export class ScpPeer {
  private readonly inbound = new ScpByteQueue();
  private status: number | null = null;
  private forwardTo: ScpPeer | null = null;
  private readonly finished: Promise<void>;

  constructor(private readonly channel: ScpTransport) {
    channel.onData((bytes) => {
      if (this.forwardTo === null) this.inbound.push(bytes);
      else this.forwardTo.writeBytes(bytes);
    });
    channel.onEof(() => this.inbound.end());
    this.finished = new Promise((resolve) => {
      channel.onClose(() => {
        this.inbound.end();
        resolve();
      });
    });
    channel.onRequest((request) => {
      if (request.name !== 'exit-status' || request.payload.length < 4) return;
      const view = new DataView(request.payload.buffer, request.payload.byteOffset, request.payload.byteLength);
      this.status = view.getUint32(0);
    });
  }

  get exitStatus(): number | null {
    return this.status;
  }

  write(text: string): void {
    this.channel.write(binaryStringToBytes(text));
  }

  writeBytes(bytes: Uint8Array): void {
    this.channel.write(bytes);
  }

  acknowledge(): void {
    this.write('\x00');
  }

  async line(): Promise<string | null> {
    const raw = await this.inbound.line();
    return raw === null ? null : bytesToBinaryString(raw);
  }

  take(count: number): Promise<Uint8Array | null> {
    return this.inbound.take(count);
  }

  async response(): Promise<ScpResponse> {
    const first = await this.inbound.take(1);
    if (first === null) return { kind: 'eof' };
    if (first[0] === SCP_ACK.OK) return { kind: 'ok' };
    const rest = await this.inbound.line();
    const text = rest === null ? '' : bytesToBinaryString(rest);
    if (first[0] === SCP_ACK.WARNING) return { kind: 'warning', text };
    if (first[0] === SCP_ACK.FATAL) return { kind: 'fatal', text };
    return { kind: 'foreign', text: `${String.fromCharCode(first[0])}${text}` };
  }

  endOfInput(): void {
    this.inbound.end();
  }

  close(): void {
    this.channel.eof();
    this.channel.close();
  }

  relayTo(other: ScpPeer): void {
    this.forwardTo = other;
    const early = this.inbound.drain();
    if (early.length > 0) other.writeBytes(early);
    this.channel.onEof(() => other.channel.eof());
    this.channel.onClose(() => other.close());
  }

  whenClosed(): Promise<void> {
    return this.finished;
  }
}
