/**
 * SCP — real byte-level wire protocol (PRD-FTP-SFTP.md §2.1.19/P18).
 * The classic `scp` "source"/"sink" protocol: the source emits one
 * control line per file/directory (`C<mode> <size> <name>`,
 * `D<mode> 0 <name>`, `E` to pop back out of a directory), waits for a
 * single acknowledgement byte from the sink before continuing, and for
 * `C` additionally streams exactly `<size>` raw bytes followed by one
 * more ack. This module is the codec only — pure encode/decode plus
 * the `ScpControlLine`/`ScpAck` shapes from §4.9 — same boundary as
 * `SftpWireCodec.ts` (P13): it doesn't touch `ScpSession.ts`/
 * `ScpTransfer.ts`, which stay on their existing, purely semantic
 * `ISftpFileSystem`-to-`ISftpFileSystem` copy until P19 migrates them.
 */

export type ScpControlKind = 'C' | 'D' | 'E';

export interface ScpControlLine {
  readonly kind: ScpControlKind;
  /** 4-digit octal permission string, e.g. `'0644'`. Empty for `E` (no such line has one on the real wire). */
  readonly mode: string;
  /** File size in bytes — only meaningful (and only sent) for `C`. */
  readonly size?: number;
  /** Empty for `E`. */
  readonly name: string;
}

/** Success / warning / fatal error (§9.1's `0x00`/`0x01`/`0x02`, matching real scp). */
export type ScpAck = 0 | 1 | 2;

export const SCP_ACK = { OK: 0, WARNING: 1, FATAL: 2 } as const;

/** `mode` (a POSIX permission bitmask, e.g. `0o644`) → the 4-digit octal string the wire carries. */
export function scpModeString(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, '0');
}

export function encodeScpControlLine(line: ScpControlLine): string {
  switch (line.kind) {
    case 'C': return `C${line.mode} ${line.size ?? 0} ${line.name}\n`;
    case 'D': return `D${line.mode} 0 ${line.name}\n`;
    case 'E': return 'E\n';
  }
}

/** `raw` may or may not include the trailing `\n`. Returns `null` for anything not matching the grammar. */
export function decodeScpControlLine(raw: string): ScpControlLine | null {
  const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (line === 'E') return { kind: 'E', mode: '', name: '' };
  const m = /^([CD])([0-7]{4}) (\d+) (.+)$/.exec(line);
  if (!m) return null;
  const [, kind, mode, size, name] = m;
  return kind === 'C'
    ? { kind: 'C', mode, size: Number(size), name }
    : { kind: 'D', mode, name };
}

/** Encodes a single ack byte; `0x01`/`0x02` are followed by a human-readable message line, matching real scp. */
export function encodeScpAck(ack: ScpAck, message?: string): Uint8Array {
  if (ack === SCP_ACK.OK) return new Uint8Array([SCP_ACK.OK]);
  const text = `${message ?? ''}\n`;
  const bytes = new Uint8Array(1 + text.length);
  bytes[0] = ack;
  for (let i = 0; i < text.length; i++) bytes[1 + i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

export function decodeScpAck(bytes: Uint8Array): { ack: ScpAck; message?: string } | null {
  if (bytes.length === 0) return null;
  const ack = bytes[0];
  if (ack !== 0 && ack !== 1 && ack !== 2) return null;
  if (ack === SCP_ACK.OK) return { ack };
  let message = '';
  for (let i = 1; i < bytes.length; i++) message += String.fromCharCode(bytes[i]);
  return { ack, message: message.replace(/\n$/, '') };
}
