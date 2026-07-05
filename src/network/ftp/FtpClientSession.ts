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
import { TlsClientSession, type TlsClientConfig } from '@/network/tls/TlsClientSession';
import type { FtpCommand, FtpReply } from './types';
import { encodeCommand, decodeReply } from './replies';
import { FTP_CONTROL_PORT } from './FtpServer';
import { encodePortArgument, decodePortArgument, encodeEprtArgument, decodeEpsvReplyArgument, type NetProtocol } from './DataChannel';
import { encodeCompressedMode, decodeCompressedMode } from './compressedMode';
import { startClientHandshake, stepHandshake, encryptText, decryptText, encodeFlight } from './ftps';

export class FtpClientSession {
  private socket: TcpSocket | null = null;
  private lastReply: FtpReply | null = null;
  private dataSocket: TcpSocket | null = null;
  private activeListener: TcpListener | null = null;
  private pendingDataHandler: ((data: unknown) => void) | null = null;
  /** Mirrors the server's negotiated `MODE S`/`MODE C` (RFC 959 §3.4.2), set once `setTransferMode()`'s `MODE` command succeeds. */
  private transferMode: 'S' | 'C' = 'S';
  /** RFC 2228/4217 — set once `authTls()`'s handshake actually completes. */
  private controlTls: TlsClientSession | null = null;
  private controlTlsHandshakePending = false;
  private controlClientSeq = 0;
  private controlServerSeq = 0;
  /** Mirrors the server's negotiated `PROT C`/`PROT P`, set once `setDataProtectionLevel()` succeeds. */
  private dataProtectionLevel: 'C' | 'P' = 'C';
  private dataTls: TlsClientSession | null = null;

  constructor(
    private readonly tcpStack: TcpStack,
    private readonly targetIp: string,
    private readonly localIp: string,
    private readonly port: number = FTP_CONTROL_PORT,
    /** Only needed to call `authTls()`/negotiate `PROT P` (RFC 2228/4217). */
    private readonly ftpsConfig?: TlsClientConfig,
  ) {}

  /** Opens the control connection and returns the server's unprompted `220` banner, or null on connection failure. */
  connect(): FtpReply | null {
    this.lastReply = null;
    const socket = this.tcpStack.connect(this.targetIp, this.port, {
      onData: (data) => this.handleIncomingControlData(data),
    });
    if (!socket || socket.state !== 'established') return null;
    this.socket = socket;
    return this.lastReply;
  }

  private handleIncomingControlData(data: unknown): void {
    if (this.controlTlsHandshakePending && this.controlTls) {
      const flight = stepHandshake(this.controlTls, String(data));
      if (flight) this.socket!.write(flight);
      if (this.controlTls.result !== null) this.controlTlsHandshakePending = false;
      return;
    }
    if (this.controlTls?.result === 'success') {
      const { text, nextSeq } = decryptText(this.controlTls.serverApplicationTrafficSecret!, this.controlServerSeq, String(data));
      this.controlServerSeq = nextSeq;
      this.lastReply = decodeReply(text);
      return;
    }
    this.lastReply = decodeReply(String(data));
  }

  /** `AUTH TLS` (RFC 2228/4217) — on success, every subsequent `sendCommand()` is transparently encrypted. */
  authTls(): FtpReply | null {
    const r = this.sendCommand({ verb: 'AUTH', argument: 'TLS' });
    if (r?.code !== 234 || !this.socket || !this.ftpsConfig) return r;
    this.controlTls = new TlsClientSession(this.ftpsConfig);
    this.controlTlsHandshakePending = true;
    // Don't use startClientHandshake() here: it subscribes its own onData,
    // which would double-dispatch alongside connect()'s already-registered
    // handleIncomingControlData(). Send the first flight directly instead;
    // the rest of the handshake is driven by that existing handler
    // (controlTlsHandshakePending routes incoming data to stepHandshake()).
    this.socket.write(encodeFlight(this.controlTls.start()));
    return r;
  }

  /**
   * The most recently received reply, without sending anything — for
   * observing a reply that arrived outside the `sendCommand()` call that
   * triggered it (e.g. FXP §2.1.6: server A's `RETR` on one control
   * connection can synchronously cascade into server B's `STOR` finishing
   * and pushing its final `226` on a *different* control connection).
   */
  get lastServerReply(): FtpReply | null {
    return this.lastReply;
  }

  /** Sends one command and returns the server's reply, or null if not connected / no reply arrived. */
  sendCommand(cmd: FtpCommand): FtpReply | null {
    if (!this.socket) return null;
    this.lastReply = null;
    const text = encodeCommand(cmd);
    if (this.controlTls?.result === 'success') {
      const { wire, nextSeq } = encryptText(this.controlTls.clientApplicationTrafficSecret!, this.controlClientSeq, text);
      this.controlClientSeq = nextSeq;
      this.socket.write(wire);
    } else {
      this.socket.write(text);
    }
    return this.lastReply;
  }

  /** `MODE S`/`MODE C` (RFC 959 §3.4.2) — updates local state only once the server confirms it. */
  setTransferMode(mode: 'S' | 'C'): FtpReply | null {
    const r = this.sendCommand({ verb: 'MODE', argument: mode });
    if (r?.code === 200) this.transferMode = mode;
    return r;
  }

  /** `PROT C`/`PROT P` (RFC 4217 §4) — call after `authTls()` + `PBSZ 0`; updates local state only once the server confirms it. */
  setDataProtectionLevel(level: 'C' | 'P'): FtpReply | null {
    const r = this.sendCommand({ verb: 'PROT', argument: level });
    if (r?.code === 200) this.dataProtectionLevel = level;
    return r;
  }

  /** `PASV` — the server listens, and the client connects in immediately. */
  enterPassiveMode(): FtpReply | null {
    this.closeActiveListener();
    this.dataSocket = null;
    this.dataTls = null;
    const r = this.sendCommand({ verb: 'PASV' });
    if (r?.code === 227) {
      const match = /\(([\d,]+)\)/.exec(r.lines[0]);
      const parsed = match ? decodePortArgument(match[1]) : null;
      if (parsed) {
        const socket = this.tcpStack.connect(parsed.address, parsed.port);
        this.dataSocket = socket && socket.state === 'established' ? socket : null;
        this.startDataTlsIfProtected();
      }
    }
    return r;
  }

  /**
   * `PROT P` (§2.1.7 scope note: `PASV`/`EPSV` only — the server is
   * always the TCP listener there, so it's naturally also the TLS
   * server; `PORT`/`EPRT` isn't wired up). Must run right after the data
   * socket is established, before any transfer command writes to it.
   */
  private startDataTlsIfProtected(): void {
    if (this.dataProtectionLevel !== 'P' || !this.dataSocket || !this.ftpsConfig) return;
    this.dataTls = startClientHandshake(this.dataSocket, this.ftpsConfig);
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
    this.dataTls = null;
    const r = this.sendCommand({ verb: 'EPSV' });
    if (r?.code === 229) {
      const port = decodeEpsvReplyArgument(r.lines[0]);
      if (port !== null) {
        const socket = this.tcpStack.connect(this.targetIp, port);
        this.dataSocket = socket && socket.state === 'established' ? socket : null;
        this.startDataTlsIfProtected();
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

  private decryptDataChunk(dataTls: TlsClientSession | null, seqRef: { seq: number }, raw: string): string {
    if (dataTls?.result !== 'success') return raw;
    const { text, nextSeq } = decryptText(dataTls.serverApplicationTrafficSecret!, seqRef.seq, raw);
    seqRef.seq = nextSeq;
    return text;
  }

  private encryptForDataSocket(content: string): string {
    if (this.dataTls?.result !== 'success') return content;
    return encryptText(this.dataTls.clientApplicationTrafficSecret!, 0, content).wire;
  }

  /** Downloads via `RETR`; call after `enterPassiveMode()`/`enterActiveMode()`. */
  retrieveFile(remotePath: string): { reply: FtpReply | null; content: string | null } {
    let content: string | null = null;
    const dataTls = this.dataTls;
    const seqRef = { seq: 0 };
    const handler = (data: unknown) => { content = (content ?? '') + this.decryptDataChunk(dataTls, seqRef, String(data)); };
    if (this.dataSocket) this.dataSocket.onData(handler);
    else this.pendingDataHandler = handler;

    const r = this.sendCommand({ verb: 'RETR', argument: remotePath });
    this.pendingDataHandler = null;
    this.dataSocket = null;
    if (content !== null && this.transferMode === 'C') content = decodeCompressedMode(content);
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
    const outgoing = this.transferMode === 'C' ? encodeCompressedMode(content) : content;
    socket.write(this.encryptForDataSocket(outgoing));
    socket.close();
    return this.lastReply;
  }

  /** Lists a directory via `LIST`/`NLST`/`MLSD` (RFC 3659 §7); call after `enterPassiveMode()`/`enterActiveMode()`. */
  list(remotePath: string | undefined, verb: 'LIST' | 'NLST' | 'MLSD' = 'LIST'): { reply: FtpReply | null; lines: string[] } {
    let raw = '';
    const dataTls = this.dataTls;
    const seqRef = { seq: 0 };
    const handler = (data: unknown) => { raw += this.decryptDataChunk(dataTls, seqRef, String(data)); };
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
