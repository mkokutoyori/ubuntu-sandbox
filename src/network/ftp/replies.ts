/**
 * FTP (RFC 959 §4) — command/reply wire codec. A reply's numeric code is
 * always exactly 3 digits (RFC 959 §4.2); a multi-line reply's first line
 * is `code-text` (hyphen), any continuation lines are free text, and the
 * final line is `code text` (space) — the same shape real clients like
 * `curl`/`ftp` parse against.
 */
import type { FtpCommand, FtpReply } from './types';

const CRLF = '\r\n';

export function reply(code: number, ...lines: string[]): FtpReply {
  return { code, lines: lines.length > 0 ? lines : [''] };
}

export function encodeReply(r: FtpReply): string {
  const code = String(r.code).padStart(3, '0');
  if (r.lines.length === 1) return `${code} ${r.lines[0]}${CRLF}`;
  const [first, ...rest] = r.lines;
  const last = rest.pop()!;
  const middle = rest.map((line) => `${line}${CRLF}`).join('');
  return `${code}-${first}${CRLF}${middle}${code} ${last}${CRLF}`;
}

export function decodeReply(raw: string): FtpReply | null {
  const lines = raw.split(CRLF).filter((_, i, arr) => i < arr.length - 1 || arr[i] !== '');
  if (lines.length === 0) return null;
  const m = /^(\d{3})([ -])(.*)$/.exec(lines[0]);
  if (!m) return null;
  const code = parseInt(m[1], 10);
  if (m[2] === ' ') return { code, lines: [m[3]] };

  const collected: string[] = [m[3]];
  for (let i = 1; i < lines.length; i++) {
    const finalMatch = new RegExp(`^${m[1]} (.*)$`).exec(lines[i]);
    if (finalMatch) {
      collected.push(finalMatch[1]);
      return { code, lines: collected };
    }
    collected.push(lines[i]);
  }
  return null;
}

export function encodeCommand(cmd: FtpCommand): string {
  return cmd.argument !== undefined ? `${cmd.verb} ${cmd.argument}${CRLF}` : `${cmd.verb}${CRLF}`;
}

export function decodeCommand(raw: string): FtpCommand | null {
  const line = raw.endsWith(CRLF) ? raw.slice(0, -2) : raw;
  if (line.length === 0) return null;
  const spaceIdx = line.indexOf(' ');
  if (spaceIdx === -1) return { verb: line.toUpperCase() };
  return { verb: line.slice(0, spaceIdx).toUpperCase(), argument: line.slice(spaceIdx + 1) };
}
