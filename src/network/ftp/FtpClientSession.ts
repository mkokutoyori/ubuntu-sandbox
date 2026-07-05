/**
 * FTP (RFC 959 §3-5) — client-side control channel. Unlike HTTP (where
 * the client always speaks first, so `Http1ClientSession.ts` can
 * subscribe/write/unsubscribe per exchange), a real FTP server sends an
 * **unprompted** `220` banner the instant the connection is accepted —
 * before the client code that called `connect()` gets a chance to
 * subscribe afterward. `TcpStack.connect()`'s own `onData` option
 * registers the handler *before* the SYN is transmitted (this simulator
 * resolves the handshake, and any immediate unsolicited data, within
 * that same synchronous call), so the handler is set up once and reused
 * for every subsequent exchange — each `write()` still resolves
 * synchronously before returning, so `lastReply` is always fresh by the
 * time `sendCommand` reads it back.
 *
 * The data channel (§2.1.2) adds a second wrinkle: in active mode
 * (`PORT`), the server only dials back into the client's listening port
 * while processing a later transfer command — so the client's own
 * `TcpStack.listen()` `onAccept` may fire *during* that later
 * `sendCommand()` call, not during `enterActiveMode()` itself. Any
 * caller that needs to read data pushed by the server (`RETR`/`LIST`)
 * therefore stages its handler as `pendingDataHandler` up front; a
 * caller that pushes data itself (`STOR`) just waits until after
 * `sendCommand()` returns, by which point `dataSocket` is populated
 * either way.
 */
import type { TcpStack, TcpSocket, TcpListener } from '@/network/tcp/TcpStack';
import type { FtpCommand, FtpReply } from './types';
import { encodeCommand, decodeReply } from './replies';
import { FTP_CONTROL_PORT } from './FtpServer';
import { encodePortArgument, decodePortArgument, encodeEprtArgument, decodeEpsvReplyArgument, type NetProtocol } from './DataChannel';

export class FtpClientSession {
  private socket: TcpSocket | null = null;
  private lastReply: FtpReply | null = null;
  private dataSocket: TcpSocket | null = null;
  private activeListener: TcpListener | null = null;
  private pendingDataHandler: ((data: unknown) => void) | null = null;

  constructor(
    private readonly tcpStack: TcpStack,
    private readonly targetIp: string,
    private readonly localIp: string,
    private readonly port: number = FTP_CONTROL_PORT,
  ) {}

  /** Opens the control connection and returns the server's unprompted `220` banner, or null on connection failure. */
  connect(): FtpReply | null {
    this.lastReply = null;
    const socket = this.tcpStack.connect(this.targetIp, this.port, {
      onData: (data) => { this.lastReply = decodeReply(String(data)); },
    });
    if (!socket || socket.state !== 'established') return null;
    this.socket = socket;
    return this.lastReply;
  }

  /** Sends one command and returns the server's reply, or null if not connected / no reply arrived. */
  sendCommand(cmd: FtpCommand): FtpReply | null {
    if (!this.socket) return null;
    this.lastReply = null;
    this.socket.write(encodeCommand(cmd));
    return this.lastReply;
  }

  /** `PASV` — the server listens, and the client connects in immediately. */
  enterPassiveMode(): FtpReply | null {
    this.closeActiveListener();
    this.dataSocket = null;
    const r = this.sendCommand({ verb: 'PASV' });
    if (r?.code === 227) {
      const match = /\(([\d,]+)\)/.exec(r.lines[0]);
      const parsed = match ? decodePortArgument(match[1]) : null;
      if (parsed) {
        const socket = this.tcpStack.connect(parsed.address, parsed.port);
        this.dataSocket = socket && socket.state === 'established' ? socket : null;
      }
    }
    return r;
  }

  /** `PORT` — the client listens on `port`; the server only dials in once a transfer command is sent. */
  enterActiveMode(port: number): FtpReply | null {
    this.closeActiveListener();
    this.dataSocket = null;
    this.activeListener = this.tcpStack.listen(port, {
      onAccept: (socket) => {
        this.dataSocket = socket;
        if (this.pendingDataHandler) socket.onData(this.pendingDataHandler);
      },
    });
    return this.sendCommand({ verb: 'PORT', argument: encodePortArgument(this.localIp, port) });
  }

  /** `EPSV` (RFC 2428) — like `enterPassiveMode()`, but via the protocol-agnostic extended command. */
  enterExtendedPassiveMode(): FtpReply | null {
    this.closeActiveListener();
    this.dataSocket = null;
    const r = this.sendCommand({ verb: 'EPSV' });
    if (r?.code === 229) {
      const port = decodeEpsvReplyArgument(r.lines[0]);
      if (port !== null) {
        const socket = this.tcpStack.connect(this.targetIp, port);
        this.dataSocket = socket && socket.state === 'established' ? socket : null;
      }
    }
    return r;
  }

  /** `EPRT` (RFC 2428) — like `enterActiveMode()`, but via the protocol-agnostic extended command; `protocol` is `1` for IPv4, `2` for IPv6. */
  enterExtendedActiveMode(port: number, protocol: NetProtocol = 1): FtpReply | null {
    this.closeActiveListener();
    this.dataSocket = null;
    this.activeListener = this.tcpStack.listen(port, {
      onAccept: (socket) => {
        this.dataSocket = socket;
        if (this.pendingDataHandler) socket.onData(this.pendingDataHandler);
      },
    });
    return this.sendCommand({ verb: 'EPRT', argument: encodeEprtArgument(protocol, this.localIp, port) });
  }

  /** Downloads via `RETR`; call after `enterPassiveMode()`/`enterActiveMode()`. */
  retrieveFile(remotePath: string): { reply: FtpReply | null; content: string | null } {
    let content: string | null = null;
    const handler = (data: unknown) => { content = String(data); };
    if (this.dataSocket) this.dataSocket.onData(handler);
    else this.pendingDataHandler = handler;

    const r = this.sendCommand({ verb: 'RETR', argument: remotePath });
    this.pendingDataHandler = null;
    this.dataSocket = null;
    return { reply: r, content };
  }

  /** Uploads via `STOR`/`STOU`/`APPE`; call after `enterPassiveMode()`/`enterActiveMode()`. */
  storeFile(remotePath: string, content: string, verb: 'STOR' | 'STOU' | 'APPE' = 'STOR'): FtpReply | null {
    this.sendCommand({ verb, argument: remotePath });
    // Active mode: the server only dials in while processing the command
    // above, so `dataSocket` only becomes available now, not before.
    const socket = this.dataSocket;
    this.dataSocket = null;
    if (!socket) return null;
    socket.write(content);
    socket.close();
    return this.lastReply;
  }

  /** Lists a directory via `LIST`/`NLST`; call after `enterPassiveMode()`/`enterActiveMode()`. */
  list(remotePath: string | undefined, verb: 'LIST' | 'NLST' = 'LIST'): { reply: FtpReply | null; lines: string[] } {
    let raw = '';
    const handler = (data: unknown) => { raw += String(data); };
    if (this.dataSocket) this.dataSocket.onData(handler);
    else this.pendingDataHandler = handler;

    const r = this.sendCommand({ verb, argument: remotePath });
    this.pendingDataHandler = null;
    this.dataSocket = null;
    const lines = raw.length > 0 ? raw.replace(/\r\n$/, '').split('\r\n') : [];
    return { reply: r, lines };
  }

  private closeActiveListener(): void {
    if (!this.activeListener) return;
    this.tcpStack.closeListener(this.activeListener.localPort, this.activeListener.localIp);
    this.activeListener = null;
  }

  close(): void {
    this.closeActiveListener();
    this.socket?.close();
    this.socket = null;
  }
}
