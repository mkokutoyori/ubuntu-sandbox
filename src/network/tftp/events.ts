/**
 * TFTP (RFC 1350) — reactive event taxonomy. One transfer per UDP
 * "conversation" (RFC 1350 §4's per-transfer TID), so — unlike FTP's
 * separate control/data channels — there's only ever a `tftp.transfer.*`
 * lifecycle to report, emitted server-side (the same convention as
 * `network/ftp/events.ts`).
 */

export interface TftpTransferRef {
  readonly transferId: string;
  readonly filename: string;
  readonly mode: 'rrq' | 'wrq';
}

export interface TftpTransferCompletedPayload extends TftpTransferRef {
  readonly bytes: number;
}

export interface TftpTransferFailedPayload extends TftpTransferRef {
  readonly errorCode: number;
  readonly reason: string;
}

export type TftpDomainEvent =
  | { topic: 'tftp.transfer.started'; payload: TftpTransferRef }
  | { topic: 'tftp.transfer.completed'; payload: TftpTransferCompletedPayload }
  | { topic: 'tftp.transfer.failed'; payload: TftpTransferFailedPayload };

let transferNonceCounter = 0;

/** A stable per-transfer correlator, matching the shape of `randomFtpConnectionId()`. */
export function randomTftpTransferId(): string {
  transferNonceCounter += 1;
  return `tftp-xfer-${transferNonceCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
