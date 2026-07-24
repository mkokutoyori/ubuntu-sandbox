/**
 * SMTP/ESMTP (RFC 5321 §4.2) — command/reply wire codec. A reply's code
 * is always exactly 3 digits; a multi-line reply's non-final lines are
 * `code-text` (hyphen), the final line is `code text` (space) — the same
 * convention already used by `network/ftp/replies.ts` for RFC 959 §4.2.
 * From P4 on, an enhanced status code (RFC 3463/5248) is carried as a
 * separate `SmtpReply.enhancedCode` field but rendered on the wire as a
 * token prefixed onto the first line's text (e.g. `250 2.1.0 Sender ok`),
 * exactly like a real server — `encodeReply`/`decodeReply` handle that
 * translation so callers never string-concatenate it themselves.
 */
import type { SmtpCommand, SmtpReply } from './types';

const CRLF = '\r\n';
const ENHANCED_CODE_RE = /^(\d\.\d{1,3}\.\d{1,3}) (.*)$/;

export function reply(code: number, ...lines: string[]): SmtpReply {
  return { code, lines: lines.length > 0 ? lines : [''] };
}

export function replyEnhanced(code: number, enhancedCode: string, ...lines: string[]): SmtpReply {
  return { code, enhancedCode, lines: lines.length > 0 ? lines : [''] };
}

export function encodeReply(r: SmtpReply): string {
  const code = String(r.code).padStart(3, '0');
  const prefix = r.enhancedCode ? `${r.enhancedCode} ` : '';
  const lines = r.lines.map((line, i) => (i === 0 ? `${prefix}${line}` : line));
  if (lines.length === 1) return `${code} ${lines[0]}${CRLF}`;
  const [first, ...rest] = lines;
  const last = rest.pop()!;
  const middle = rest.map((line) => `${line}${CRLF}`).join('');
  return `${code}-${first}${CRLF}${middle}${code} ${last}${CRLF}`;
}

export function decodeReply(raw: string): SmtpReply | null {
  const lines = raw.split(CRLF).filter((_, i, arr) => i < arr.length - 1 || arr[i] !== '');
  if (lines.length === 0) return null;
  const m = /^(\d{3})([ -])(.*)$/.exec(lines[0]);
  if (!m) return null;
  const code = parseInt(m[1], 10);

  const collected: string[] = [m[3]];
  if (m[2] === ' ') return finalizeReply(code, collected);

  for (let i = 1; i < lines.length; i++) {
    const finalMatch = new RegExp(`^${m[1]} (.*)$`).exec(lines[i]);
    if (finalMatch) {
      collected.push(finalMatch[1]);
      return finalizeReply(code, collected);
    }
    collected.push(lines[i]);
  }
  return null;
}

function finalizeReply(code: number, lines: string[]): SmtpReply {
  const em = ENHANCED_CODE_RE.exec(lines[0]);
  if (!em) return { code, lines };
  return { code, enhancedCode: em[1], lines: [em[2], ...lines.slice(1)] };
}

export function encodeCommand(cmd: SmtpCommand): string {
  return cmd.argument !== undefined ? `${cmd.verb} ${cmd.argument}${CRLF}` : `${cmd.verb}${CRLF}`;
}

export function decodeCommand(raw: string): SmtpCommand | null {
  const line = raw.endsWith(CRLF) ? raw.slice(0, -2) : raw;
  if (line.length === 0) return null;
  const spaceIdx = line.indexOf(' ');
  if (spaceIdx === -1) return { verb: line.toUpperCase() };
  return { verb: line.slice(0, spaceIdx).toUpperCase(), argument: line.slice(spaceIdx + 1) };
}
