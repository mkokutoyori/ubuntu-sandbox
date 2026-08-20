/**
 * TFTP (RFC 1350 §5, RFC 2347/2348/2349) — packet types. Independent of
 * the rest of `PRD-FTP-SFTP.md`: no control/data channel split, no
 * authentication, five opcodes, UDP/69. `OACK` (RFC 2347) carries the
 * negotiated subset of `blksize` (RFC 2348) / `timeout` / `tsize` (RFC
 * 2349) that RRQ/WRQ requested.
 */

export type TftpMode = 'netascii' | 'octet' | 'mail';

export interface TftpOptions {
  readonly blksize?: number;
  readonly timeout?: number;
  readonly tsize?: number;
}

export interface TftpRequestPacket {
  readonly opcode: 'RRQ' | 'WRQ';
  readonly filename: string;
  readonly mode: TftpMode;
  readonly options?: TftpOptions;
}

export interface TftpDataPacket {
  readonly opcode: 'DATA';
  readonly block: number;
  readonly data: Uint8Array;
}

export interface TftpAckPacket {
  readonly opcode: 'ACK';
  readonly block: number;
}

export interface TftpErrorPacket {
  readonly opcode: 'ERROR';
  readonly code: number;
  readonly message: string;
}

export interface TftpOackPacket {
  readonly opcode: 'OACK';
  readonly options: TftpOptions;
}

export type TftpPacket = TftpRequestPacket | TftpDataPacket | TftpAckPacket | TftpErrorPacket | TftpOackPacket;

/**
 * What a TFTP endpoint needs from the machine underneath it, and nothing
 * more. `TftpClientSession` used to be typed against `EndHost`, which is
 * why a router could not run one: a `Router` is not an `EndHost` and
 * never will be, yet `copy running-config tftp:` is a router command
 * before it is a host one. These four members are the whole surface both
 * sessions ever touched.
 */
export interface TftpEndpoint {
  allocateEphemeralPort(): number;
  udpBind(port: number, handler: (delivery: TftpUdpDelivery) => void, owner?: string): boolean;
  udpClose(port: number): void;
  sendUdpDatagramTo(
    destIP: unknown, destPort: number, sourcePort: number,
    payload: Uint8Array, length: number,
  ): boolean;
}

/** The one shape of a delivered datagram a TFTP session reads. */
export interface TftpUdpDelivery {
  readonly udp: { readonly sourcePort: number; readonly payload: unknown };
  readonly sourceIP: { toString(): string };
}

export const TFTP_PORT = 69;
export const TFTP_DEFAULT_BLKSIZE = 512;
export const TFTP_DEFAULT_TIMEOUT_SEC = 5;
export const TFTP_MAX_RETRIES = 5;

/** RFC 1350 §5 codes 0-7; code 8 ("option negotiation failed") is a widely-implemented convention, not itself part of RFC 1350/2347. */
export const TFTP_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  0: 'Not defined, see error message (if any).',
  1: 'File not found.',
  2: 'Access violation.',
  3: 'Disk full or allocation exceeded.',
  4: 'Illegal TFTP operation.',
  5: 'Unknown transfer ID.',
  6: 'File already exists.',
  7: 'No such user.',
  8: 'Terminate transfer due to option negotiation.',
};
