/**
 * SFTP (PRD-FTP-SFTP.md §2.1.18/P17) — reactive event taxonomy for the
 * real wire session (`SftpWireSession.ts`). Like FTP/HTTP, an SFTP
 * exchange is synchronous request/response over one channel (no
 * timer-driven actor engine needed) — events are emitted inline from
 * `SftpWireSession.handle()`, mirroring `network/ftp/events.ts`'s shape.
 */

export interface SftpSessionRef {
  readonly sessionId: string;
}

export interface SftpPacketPayload extends SftpSessionRef {
  readonly packetType: string;
  readonly requestId?: number;
}

export type SftpHandleKind = 'file-read' | 'file-write' | 'dir';

export interface SftpHandleOpenedPayload extends SftpSessionRef {
  readonly handle: string;
  readonly kind: SftpHandleKind;
  readonly path: string;
}

export interface SftpHandleClosedPayload extends SftpSessionRef {
  readonly handle: string;
}

export interface SftpTransferProgressPayload extends SftpSessionRef {
  readonly handle: string;
  readonly bytesTransferred: number;
}

export type SftpDomainEvent =
  | { topic: 'sftp.packet.received'; payload: SftpPacketPayload }
  | { topic: 'sftp.packet.sent'; payload: SftpPacketPayload }
  | { topic: 'sftp.handle.opened'; payload: SftpHandleOpenedPayload }
  | { topic: 'sftp.handle.closed'; payload: SftpHandleClosedPayload }
  | { topic: 'sftp.transfer.progress'; payload: SftpTransferProgressPayload };

let sessionNonceCounter = 0;

/** A stable per-session correlator, matching the shape of `randomFtpConnectionId()`. */
export function randomSftpSessionId(): string {
  sessionNonceCounter += 1;
  return `sftp-sess-${sessionNonceCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
