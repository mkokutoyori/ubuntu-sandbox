import type { MailEnvelope, MimeMessage } from './types';

const CRLF = '\r\n';

export function parseMailFromArgument(argument: string | undefined): string | null {
  if (!argument) return null;
  const m = /^FROM:<([^>]*)>/i.exec(argument.trim());
  return m ? m[1] : null;
}

export function parseRcptToArgument(argument: string | undefined): string | null {
  if (!argument) return null;
  const m = /^TO:<([^>]*)>/i.exec(argument.trim());
  return m ? m[1] : null;
}

export function buildEnvelope(from: string, to: readonly string[]): MailEnvelope {
  return { from, to: [...to] };
}

export function stuffDotLines(body: string): string {
  return body.split(CRLF).map((line) => (line.startsWith('.') ? `.${line}` : line)).join(CRLF);
}

export function unstuffDotLines(body: string): string {
  return body.split(CRLF).map((line) => (line.startsWith('..') ? line.slice(1) : line)).join(CRLF);
}

export function splitHeadersAndBody(rawMessage: string): MimeMessage {
  const lines = rawMessage.split(CRLF);
  const blankIdx = lines.indexOf('');
  const headerLines = blankIdx === -1 ? lines : lines.slice(0, blankIdx);
  const bodyLines = blankIdx === -1 ? [] : lines.slice(blankIdx + 1);

  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    headers.set(line.slice(0, colonIdx).trim(), line.slice(colonIdx + 1).trim());
  }
  return { headers, body: bodyLines.join(CRLF) };
}
