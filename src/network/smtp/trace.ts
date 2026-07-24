const CRLF = '\r\n';

export interface ReceivedHeader {
  readonly fromHelo: string;
  readonly fromIp: string;
  readonly by: string;
  readonly withProtocol: 'SMTP' | 'ESMTP' | 'ESMTPS' | 'ESMTPA';
  readonly forRecipient?: string;
  readonly timestamp: number;
}

export interface ReturnPath {
  readonly address: string;
}

export function determineProtocolLabel(extended: boolean, tlsActive: boolean, authActive: boolean): ReceivedHeader['withProtocol'] {
  if (tlsActive) return 'ESMTPS';
  if (authActive) return 'ESMTPA';
  return extended ? 'ESMTP' : 'SMTP';
}

export function formatReceivedLine(h: ReceivedHeader): string {
  const forClause = h.forRecipient ? ` for <${h.forRecipient}>` : '';
  return `Received: from ${h.fromHelo} ([${h.fromIp}]) by ${h.by} with ${h.withProtocol}${forClause}; ${new Date(h.timestamp).toUTCString()}`;
}

export function prependReceivedHeader(rawMessage: string, h: ReceivedHeader): string {
  return `${formatReceivedLine(h)}${CRLF}${rawMessage}`;
}

export function formatReturnPathLine(rp: ReturnPath): string {
  return `Return-Path: <${rp.address}>`;
}

export function prependReturnPath(rawMessage: string, rp: ReturnPath): string {
  return `${formatReturnPathLine(rp)}${CRLF}${rawMessage}`;
}

export function extractReceivedChain(rawMessage: string): string[] {
  const lines = rawMessage.split(CRLF);
  const received: string[] = [];
  for (const line of lines) {
    if (line === '') break;
    if (/^Received:/i.test(line)) received.push(line);
  }
  return received;
}

export function extractReturnPath(rawMessage: string): string | null {
  const lines = rawMessage.split(CRLF);
  for (const line of lines) {
    if (line === '') break;
    const m = /^Return-Path:\s*<([^>]*)>/i.exec(line);
    if (m) return m[1];
  }
  return null;
}
