/**
 * TFTP (RFC 1350 §4-5, RFC 2347-2349) — server + client. Each transfer is
 * its own UDP "conversation": the server replies from a fresh ephemeral
 * port (its Transfer ID, RFC 1350 §4), and every subsequent packet in
 * that transfer must come from that exact (IP, port) pair — anything
 * else gets `ERROR 5 Unknown transfer ID` without disturbing the
 * transfer in progress. Reuses `ISftpFileSystem` for file access (same
 * reuse-first approach as `network/ftp/`), independent of everything
 * else in this PRD otherwise (no control channel, no auth).
 */
import type { IPAddress, IPv6Address } from '@/network/core/types';
import type { ISftpFileSystem } from '@/network/protocols/ssh/sftp/ISftpFileSystem';
import type { IEventBus } from '@/events/EventBus';
import {
  type TftpPacket, type TftpRequestPacket, type TftpOptions, type TftpMode,
  type TftpEndpoint, type TftpUdpDelivery,
  TFTP_PORT, TFTP_DEFAULT_BLKSIZE, TFTP_DEFAULT_TIMEOUT_SEC, TFTP_MAX_RETRIES, TFTP_ERROR_MESSAGES,
} from './types';
import { encodeTftpPacket, decodeTftpPacket, concatBytes } from './codec';
import { negotiateOptions } from './options';
import { randomTftpTransferId } from './events';

function stringToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function bytesToString(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

function joinRoot(root: string, filename: string): string {
  const base = root.endsWith('/') ? root.slice(0, -1) : root;
  return filename.startsWith('/') ? filename : `${base}/${filename}`;
}

export interface TftpServerConfig {
  readonly fs: ISftpFileSystem;
  readonly rootPath?: string;
  readonly eventBus?: IEventBus;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

/** One in-flight transfer's send/retry/close plumbing — shared shape for both RRQ and WRQ service loops. */
class TransferIo {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSentPayload: Uint8Array | null = null;
  private retries = 0;
  private peerPort: number;

  constructor(
    private readonly host: TftpEndpoint,
    private readonly peerIP: IPAddress | IPv6Address,
    initialPeerPort: number,
    private readonly localPort: number,
    private readonly timeoutMs: number,
    private readonly maxRetries: number,
    private readonly onGiveUp: () => void,
  ) {
    this.peerPort = initialPeerPort;
  }

  /** Client side only: the server's real ephemeral port (its TID) is only known once its first reply arrives — every send() after that point must target it instead of the well-known port 69. */
  retarget(newPeerPort: number): void {
    this.peerPort = newPeerPort;
  }

  send(pkt: TftpPacket): void {
    const payload = encodeTftpPacket(pkt);
    this.lastSentPayload = payload;
    this.host.sendUdpDatagramTo(this.peerIP, this.peerPort, this.localPort, payload, payload.length);
    this.rearm();
  }

  private rearm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.onTimeout(), this.timeoutMs);
  }

  private onTimeout(): void {
    this.retries++;
    if (this.retries > this.maxRetries) { this.close(); this.onGiveUp(); return; }
    if (this.lastSentPayload) {
      this.host.sendUdpDatagramTo(this.peerIP, this.peerPort, this.localPort, this.lastSentPayload, this.lastSentPayload.length);
    }
    this.rearm();
  }

  resetRetries(): void { this.retries = 0; }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.host.udpClose(this.localPort);
  }
}

export class TftpServer {
  private readonly rootPath: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly host: TftpEndpoint, private readonly config: TftpServerConfig) {
    this.rootPath = config.rootPath ?? '/';
    this.timeoutMs = config.timeoutMs ?? TFTP_DEFAULT_TIMEOUT_SEC * 1000;
    this.maxRetries = config.maxRetries ?? TFTP_MAX_RETRIES;
  }

  start(): void {
    this.host.udpBind(TFTP_PORT, (delivery) => this.handleRequest(delivery), 'tftp');
  }

  stop(): void {
    this.host.udpClose(TFTP_PORT);
  }

  private handleRequest(delivery: TftpUdpDelivery): void {
    if (!(delivery.udp.payload instanceof Uint8Array)) return;
    const pkt = decodeTftpPacket(delivery.udp.payload);
    if (!pkt) return;
    if (pkt.opcode === 'RRQ') this.serveRead(pkt, delivery.sourceIP, delivery.udp.sourcePort);
    else if (pkt.opcode === 'WRQ') this.serveWrite(pkt, delivery.sourceIP, delivery.udp.sourcePort);
  }

  private emitStarted(transferId: string, filename: string, mode: 'rrq' | 'wrq'): void {
    this.config.eventBus?.publish({ topic: 'tftp.transfer.started', payload: { transferId, filename, mode } });
  }
  private emitCompleted(transferId: string, filename: string, mode: 'rrq' | 'wrq', bytes: number): void {
    this.config.eventBus?.publish({ topic: 'tftp.transfer.completed', payload: { transferId, filename, mode, bytes } });
  }
  private emitFailed(transferId: string, filename: string, mode: 'rrq' | 'wrq', errorCode: number, reason: string): void {
    this.config.eventBus?.publish({ topic: 'tftp.transfer.failed', payload: { transferId, filename, mode, errorCode, reason } });
  }

  private rejectUnknownTid(delivery: TftpUdpDelivery, localPort: number): void {
    if (!(delivery.udp.payload instanceof Uint8Array)) return;
    const err = encodeTftpPacket({ opcode: 'ERROR', code: 5, message: TFTP_ERROR_MESSAGES[5] });
    this.host.sendUdpDatagramTo(delivery.sourceIP, delivery.udp.sourcePort, localPort, err, err.length);
  }

  private serveRead(req: TftpRequestPacket, clientIP: IPAddress | IPv6Address, clientPort: number): void {
    const transferId = randomTftpTransferId();
    const path = joinRoot(this.rootPath, req.filename);
    const file = this.config.fs.readFile(path);
    const localPort = this.host.allocateEphemeralPort();

    if (!file.ok) {
      const err = encodeTftpPacket({ opcode: 'ERROR', code: 1, message: TFTP_ERROR_MESSAGES[1] });
      this.host.sendUdpDatagramTo(clientIP, clientPort, localPort, err, err.length);
      this.emitFailed(transferId, req.filename, 'rrq', 1, TFTP_ERROR_MESSAGES[1]);
      return;
    }

    this.emitStarted(transferId, req.filename, 'rrq');
    const dataBytes = stringToBytes(file.value);
    const negotiated = negotiateOptions(req.options);
    const blksize = negotiated?.blksize ?? TFTP_DEFAULT_BLKSIZE;
    const totalBlocks = Math.floor(dataBytes.length / blksize) + 1;
    let currentBlock = negotiated ? 0 : 1;

    const io = new TransferIo(this.host, clientIP, clientPort, localPort, this.timeoutMs, this.maxRetries, () => {
      this.emitFailed(transferId, req.filename, 'rrq', 0, 'Transfer timed out.');
    });

    const sendCurrentBlock = (): void => {
      if (currentBlock === 0) { io.send({ opcode: 'OACK', options: negotiated! }); return; }
      const start = (currentBlock - 1) * blksize;
      io.send({ opcode: 'DATA', block: currentBlock, data: dataBytes.slice(start, start + blksize) });
    };

    this.host.udpBind(localPort, (delivery) => {
      if (delivery.sourceIP.toString() !== clientIP.toString() || delivery.udp.sourcePort !== clientPort) {
        this.rejectUnknownTid(delivery, localPort);
        return;
      }
      if (!(delivery.udp.payload instanceof Uint8Array)) return;
      const ack = decodeTftpPacket(delivery.udp.payload);
      if (!ack || ack.opcode !== 'ACK' || ack.block !== currentBlock) return;
      io.resetRetries();
      if (currentBlock >= totalBlocks) {
        io.close();
        this.emitCompleted(transferId, req.filename, 'rrq', dataBytes.length);
        return;
      }
      currentBlock++;
      sendCurrentBlock();
    }, 'tftp-transfer');

    sendCurrentBlock();
  }

  private serveWrite(req: TftpRequestPacket, clientIP: IPAddress | IPv6Address, clientPort: number): void {
    const transferId = randomTftpTransferId();
    const path = joinRoot(this.rootPath, req.filename);
    const localPort = this.host.allocateEphemeralPort();
    this.emitStarted(transferId, req.filename, 'wrq');

    const negotiated = negotiateOptions(req.options);
    const blksize = negotiated?.blksize ?? TFTP_DEFAULT_BLKSIZE;
    let expectedBlock = 1;
    const received: Uint8Array[] = [];

    const io = new TransferIo(this.host, clientIP, clientPort, localPort, this.timeoutMs, this.maxRetries, () => {
      this.emitFailed(transferId, req.filename, 'wrq', 0, 'Transfer timed out.');
    });

    this.host.udpBind(localPort, (delivery) => {
      if (delivery.sourceIP.toString() !== clientIP.toString() || delivery.udp.sourcePort !== clientPort) {
        this.rejectUnknownTid(delivery, localPort);
        return;
      }
      if (!(delivery.udp.payload instanceof Uint8Array)) return;
      const pkt = decodeTftpPacket(delivery.udp.payload);
      if (!pkt || pkt.opcode !== 'DATA') return;

      if (pkt.block === expectedBlock - 1) { io.send({ opcode: 'ACK', block: pkt.block }); return; } // duplicate, ack already lost in flight
      if (pkt.block !== expectedBlock) return;

      io.resetRetries();
      received.push(pkt.data);
      const isLast = pkt.data.length < blksize;
      const ackedBlock = expectedBlock;
      // Advance state before sending the ACK: UDP delivery here is
      // synchronous, so io.send() can recursively re-enter this same
      // handler (the peer's next DATA block) before it returns.
      if (!isLast) expectedBlock++;
      io.send({ opcode: 'ACK', block: ackedBlock });
      if (isLast) {
        io.close();
        const content = bytesToString(concatBytes(received));
        const written = this.config.fs.writeFile(path, content);
        if (!written.ok) { this.emitFailed(transferId, req.filename, 'wrq', 2, TFTP_ERROR_MESSAGES[2]); return; }
        this.emitCompleted(transferId, req.filename, 'wrq', content.length);
      }
    }, 'tftp-transfer');

    io.send(negotiated ? { opcode: 'OACK', options: negotiated } : { opcode: 'ACK', block: 0 });
  }
}

export interface TftpTransferResult {
  readonly ok: boolean;
  readonly content?: string;
  readonly error?: string;
}

export class TftpClientSession {
  constructor(
    private readonly host: TftpEndpoint,
    private readonly serverIp: IPAddress | IPv6Address,
    private readonly port: number = TFTP_PORT,
    private readonly timeoutMs: number = TFTP_DEFAULT_TIMEOUT_SEC * 1000,
    private readonly maxRetries: number = TFTP_MAX_RETRIES,
  ) {}

  /** `RRQ` — downloads `filename`; mode is always octet (binary-transparent), matching the rest of this project's file-content convention. */
  get(filename: string, options?: TftpOptions): Promise<TftpTransferResult> {
    return new Promise((resolve) => {
      const localPort = this.host.allocateEphemeralPort();
      let serverPort: number | null = null;
      let expectedBlock = 1;
      const received: Uint8Array[] = [];
      const blksize = options?.blksize ?? TFTP_DEFAULT_BLKSIZE;

      const io = new TransferIo(this.host, this.serverIp, this.port, localPort, this.timeoutMs, this.maxRetries, () => {
        finish({ ok: false, error: 'Timed out.' });
      });
      const finish = (result: TftpTransferResult): void => { io.close(); resolve(result); };

      this.host.udpBind(localPort, (delivery) => {
        if (!(delivery.udp.payload instanceof Uint8Array)) return;
        if (serverPort !== null && delivery.udp.sourcePort !== serverPort) return;
        const pkt = decodeTftpPacket(delivery.udp.payload);
        if (!pkt) return;
        io.resetRetries();
        if (pkt.opcode === 'ERROR') { finish({ ok: false, error: pkt.message }); return; }
        if (serverPort === null) { serverPort = delivery.udp.sourcePort; io.retarget(serverPort); }

        if (pkt.opcode === 'OACK') { io.send({ opcode: 'ACK', block: 0 }); return; }
        if (pkt.opcode !== 'DATA' || pkt.block !== expectedBlock) return;
        received.push(pkt.data);
        const isLast = pkt.data.length < blksize;
        const ackedBlock = expectedBlock;
        // Advance state before sending the ACK: UDP delivery here is
        // synchronous, so io.send() can recursively re-enter this same
        // handler (the peer's next DATA block) before it returns.
        if (!isLast) expectedBlock++;
        io.send({ opcode: 'ACK', block: ackedBlock });
        if (isLast) finish({ ok: true, content: bytesToString(concatBytes(received)) });
      }, 'tftp-client');

      const reqOptions = options && Object.keys(options).length > 0 ? options : undefined;
      io.send({ opcode: 'RRQ', filename, mode: 'octet' as TftpMode, options: reqOptions });
    });
  }

  /** `WRQ` — uploads `content` to `filename`. */
  put(filename: string, content: string, options?: TftpOptions): Promise<TftpTransferResult> {
    return new Promise((resolve) => {
      const localPort = this.host.allocateEphemeralPort();
      let serverPort: number | null = null;
      const dataBytes = stringToBytes(content);
      const blksize = options?.blksize ?? TFTP_DEFAULT_BLKSIZE;
      const totalBlocks = Math.floor(dataBytes.length / blksize) + 1;
      let currentBlock = 0;
      let awaitingInitial = true;

      const io = new TransferIo(this.host, this.serverIp, this.port, localPort, this.timeoutMs, this.maxRetries, () => {
        finish({ ok: false, error: 'Timed out.' });
      });
      const finish = (result: TftpTransferResult): void => { io.close(); resolve(result); };

      const sendBlock = (block: number): void => {
        const start = (block - 1) * blksize;
        io.send({ opcode: 'DATA', block, data: dataBytes.slice(start, start + blksize) });
      };

      this.host.udpBind(localPort, (delivery) => {
        if (!(delivery.udp.payload instanceof Uint8Array)) return;
        if (serverPort !== null && delivery.udp.sourcePort !== serverPort) return;
        const pkt = decodeTftpPacket(delivery.udp.payload);
        if (!pkt) return;
        io.resetRetries();
        if (pkt.opcode === 'ERROR') { finish({ ok: false, error: pkt.message }); return; }
        if (serverPort === null) { serverPort = delivery.udp.sourcePort; io.retarget(serverPort); }

        if (awaitingInitial) {
          if (pkt.opcode !== 'OACK' && pkt.opcode !== 'ACK') return;
          awaitingInitial = false;
          currentBlock = 1;
          sendBlock(currentBlock);
          return;
        }
        if (pkt.opcode !== 'ACK' || pkt.block !== currentBlock) return;
        if (currentBlock >= totalBlocks) { finish({ ok: true }); return; }
        currentBlock++;
        sendBlock(currentBlock);
      }, 'tftp-client');

      const reqOptions = options && Object.keys(options).length > 0 ? options : undefined;
      io.send({ opcode: 'WRQ', filename, mode: 'octet' as TftpMode, options: reqOptions });
    });
  }
}
