import type { TcpSocket } from '@/network/tcp/TcpStack';
import { encodeFrame, decodeFrame, type WebSocketOpcode } from './WebSocketFrame';
import type { IEventBus } from '@/events/EventBus';
import { randomHttpConnectionId } from '../events';

export type WebSocketRole = 'client' | 'server';

export interface WebSocketMessage {
  opcode: 'text' | 'binary';
  payload: Uint8Array;
}

// The project's convention for real binary protocols over the string-based
// TcpSocket transport (cf. DnsHttpsTransport.ts): one character per byte.
export function bytesToBinaryString(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

export function binaryStringToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

function randomMaskingKey(): [number, number, number, number] {
  return [
    Math.floor(Math.random() * 256), Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256), Math.floor(Math.random() * 256),
  ];
}

function encodeCloseBody(code: number, reason: string): Uint8Array {
  const reasonBytes = new TextEncoder().encode(reason);
  const out = new Uint8Array(2 + reasonBytes.length);
  out[0] = (code >> 8) & 0xff;
  out[1] = code & 0xff;
  out.set(reasonBytes, 2);
  return out;
}

function decodeCloseBody(payload: Uint8Array): { code: number; reason: string } {
  if (payload.length < 2) return { code: 1005, reason: '' };
  const code = (payload[0] << 8) | payload[1];
  const reason = new TextDecoder().decode(payload.slice(2));
  return { code, reason };
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

/**
 * Event-driven WebSocket connection over an already-upgraded `TcpSocket`
 * (RFC 6455). Masks all outgoing frames when acting as `client` and never
 * masks as `server` (§5.1); reassembles fragmented messages (continuation
 * frames); auto-replies to `ping` with `pong`; a `close` frame is answered
 * with `close` and tears down the socket.
 */
export class WebSocketConnection {
  private closed = false;
  private fragments: Uint8Array[] = [];
  private fragmentOpcode: 'text' | 'binary' | null = null;
  private messageHandlers: Array<(msg: WebSocketMessage) => void> = [];
  private closeHandlers: Array<(code: number, reason: string) => void> = [];
  private pongHandlers: Array<(payload: Uint8Array) => void> = [];
  private readonly connectionId = randomHttpConnectionId();

  constructor(private readonly socket: TcpSocket, private readonly role: WebSocketRole, private readonly eventBus?: IEventBus) {
    socket.onData((data) => this.handleIncoming(binaryStringToBytes(String(data))));
    this.eventBus?.publish({ topic: 'websocket.opened', payload: { connectionId: this.connectionId } });
  }

  private sendFrame(opcode: WebSocketOpcode, payload: Uint8Array, fin = true): void {
    const masked = this.role === 'client';
    const maskingKey = masked ? randomMaskingKey() : undefined;
    this.socket.write(bytesToBinaryString(encodeFrame({ fin, opcode, masked, maskingKey, payload })));
  }

  send(data: string | Uint8Array): void {
    if (this.closed) return;
    if (typeof data === 'string') this.sendFrame('text', new TextEncoder().encode(data));
    else this.sendFrame('binary', data);
  }

  /** Sends one logical message split across several continuation frames. */
  sendFragmented(chunks: (string | Uint8Array)[]): void {
    if (this.closed || chunks.length === 0) return;
    const encoded = chunks.map((c) => (typeof c === 'string' ? new TextEncoder().encode(c) : c));
    const firstOpcode: WebSocketOpcode = typeof chunks[0] === 'string' ? 'text' : 'binary';
    encoded.forEach((chunk, i) => {
      const opcode = i === 0 ? firstOpcode : 'continuation';
      const fin = i === encoded.length - 1;
      this.sendFrame(opcode, chunk, fin);
    });
  }

  ping(payload: Uint8Array = new Uint8Array(0)): void {
    if (!this.closed) this.sendFrame('ping', payload);
  }

  onMessage(handler: (msg: WebSocketMessage) => void): () => void {
    this.messageHandlers.push(handler);
    return () => {
      const i = this.messageHandlers.indexOf(handler);
      if (i !== -1) this.messageHandlers.splice(i, 1);
    };
  }

  onClose(handler: (code: number, reason: string) => void): () => void {
    this.closeHandlers.push(handler);
    return () => {
      const i = this.closeHandlers.indexOf(handler);
      if (i !== -1) this.closeHandlers.splice(i, 1);
    };
  }

  onPong(handler: (payload: Uint8Array) => void): () => void {
    this.pongHandlers.push(handler);
    return () => {
      const i = this.pongHandlers.indexOf(handler);
      if (i !== -1) this.pongHandlers.splice(i, 1);
    };
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.sendFrame('close', encodeCloseBody(code, reason));
    this.socket.close();
    this.eventBus?.publish({ topic: 'websocket.closed', payload: { connectionId: this.connectionId, code, reason } });
    for (const h of this.closeHandlers) h(code, reason);
  }

  private handleIncoming(bytes: Uint8Array): void {
    const decoded = decodeFrame(bytes);
    if (!decoded) return;
    const { frame } = decoded;

    switch (frame.opcode) {
      case 'text':
      case 'binary':
        if (!frame.fin) {
          this.fragments = [frame.payload];
          this.fragmentOpcode = frame.opcode;
          return;
        }
        this.emitMessage(frame.opcode, frame.payload);
        return;
      case 'continuation':
        this.fragments.push(frame.payload);
        if (frame.fin && this.fragmentOpcode) {
          const full = concatBytes(this.fragments);
          const opcode = this.fragmentOpcode;
          this.fragments = [];
          this.fragmentOpcode = null;
          this.emitMessage(opcode, full);
        }
        return;
      case 'ping':
        this.sendFrame('pong', frame.payload);
        return;
      case 'pong':
        for (const h of this.pongHandlers) h(frame.payload);
        return;
      case 'close': {
        const { code, reason } = decodeCloseBody(frame.payload);
        if (!this.closed) {
          this.closed = true;
          this.sendFrame('close', encodeCloseBody(code, reason));
          this.socket.close();
          this.eventBus?.publish({ topic: 'websocket.closed', payload: { connectionId: this.connectionId, code, reason } });
        }
        for (const h of this.closeHandlers) h(code, reason);
        return;
      }
      default:
        return;
    }
  }

  private emitMessage(opcode: 'text' | 'binary', payload: Uint8Array): void {
    for (const h of this.messageHandlers) h({ opcode, payload });
  }
}
