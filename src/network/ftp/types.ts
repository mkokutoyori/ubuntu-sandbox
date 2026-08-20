/**
 * FTP (RFC 959) — core wire types. Deliberately at the same fidelity
 * level as the rest of this project's text protocols (HTTP/1.1's
 * `Http1Wire.ts`): real command/reply framing, but each `TcpSocket`
 * `send()`/`onData()` call carries one complete logical unit (this
 * simulator delivers messages, not a raw byte stream needing manual
 * reassembly — see `Http1ServerSession.ts`), so no chunk buffering is
 * needed here either.
 */

export interface FtpCommand {
  readonly verb: string;
  readonly argument?: string;
}

export interface FtpReply {
  readonly code: number;
  readonly lines: readonly string[];
}

/** RFC 959 §3.1.1 — the only transfer type this PRD's phase 1 needs; `TYPE` negotiates between them. */
export type FtpTransferType = 'A' | 'I';

/** RFC 959 §3.1.2 — only `F` (file structure) is in scope. */
export type FtpFileStructure = 'F';

/** RFC 959 §3.4 — `S` (stream) is the nominal mode; `C` (compressed, `PRD-FTP-SFTP.md` §2.1.5) is added in a later phase. */
export type FtpTransferMode = 'S' | 'C';
