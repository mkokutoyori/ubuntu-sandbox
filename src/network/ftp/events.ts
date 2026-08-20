/**
 * FTP (PRD-FTP-SFTP.md §2.1.12) — reactive event taxonomy for the control
 * channel, data channel, transfers, and FTPS. FTP's control channel is
 * synchronous request/response, just like HTTP — so, mirroring
 * `network/http/events.ts` rather than DHCP/OSPF/BGP's actor-based
 * reactive engines (built for asynchronous, timer-driven protocols),
 * events are emitted inline from `FtpServerSession`/`FtpServer.ts`.
 * Server-side only, matching how a real FTP daemon (vsftpd) is the side
 * that actually logs these lifecycle events.
 */

export interface FtpConnectionRef {
  readonly connectionId: string;
}

export interface FtpControlAuthenticatedPayload extends FtpConnectionRef {
  readonly username: string;
}

export interface FtpControlClosedPayload extends FtpConnectionRef {
  readonly reason: string;
}

export interface FtpDataChannelPayload extends FtpConnectionRef {
  readonly mode: 'active' | 'passive';
}

export interface FtpCommandReceivedPayload extends FtpConnectionRef {
  readonly verb: string;
}

export interface FtpTransferRef extends FtpConnectionRef {
  readonly verb: string;
  readonly path: string;
}

export interface FtpTransferCompletedPayload extends FtpTransferRef {
  readonly bytes: number;
}

export interface FtpTransferFailedPayload extends FtpTransferRef {
  readonly reason: string;
}

export interface FtpsTlsEstablishedPayload extends FtpConnectionRef {
  readonly negotiatedCipherSuite: string | null;
}

export type FtpDomainEvent =
  | { topic: 'ftp.control.connected'; payload: FtpConnectionRef }
  | { topic: 'ftp.control.authenticated'; payload: FtpControlAuthenticatedPayload }
  | { topic: 'ftp.control.closed'; payload: FtpControlClosedPayload }
  | { topic: 'ftp.data.opened'; payload: FtpDataChannelPayload }
  | { topic: 'ftp.data.closed'; payload: FtpDataChannelPayload }
  | { topic: 'ftp.command.received'; payload: FtpCommandReceivedPayload }
  | { topic: 'ftp.transfer.started'; payload: FtpTransferRef }
  | { topic: 'ftp.transfer.completed'; payload: FtpTransferCompletedPayload }
  | { topic: 'ftp.transfer.failed'; payload: FtpTransferFailedPayload }
  | { topic: 'ftps.tls.established'; payload: FtpsTlsEstablishedPayload };

let connectionNonceCounter = 0;

/** A stable per-connection correlator, matching the shape of `randomHttpConnectionId()`. */
export function randomFtpConnectionId(): string {
  connectionNonceCounter += 1;
  return `ftp-conn-${connectionNonceCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
