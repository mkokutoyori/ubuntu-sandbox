import type { IPAddress } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { DnsMessageHandler } from '@/network/dns/transport/DnsUdpTransport';
import { bindTlsByteService, unbindTlsByteService, sendTlsRequest } from '@/network/dns/transport/SimulatedTls';

export const DOH_PORT = 443;
export const DOH_ALPN = 'h2';
export const DOH_PATH = '/dns-query';
export const DOH_CONTENT_TYPE = 'application/dns-message';

const HEADER_SEPARATOR = '\r\n\r\n';

export interface DohOptions {
  readonly port?: number;
  readonly path?: string;
  readonly sni?: string;
  readonly timeoutMs?: number;
}

interface HttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: Uint8Array;
}

function textToBytes(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xff);
  return bytes;
}

function bytesToText(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

function findHeaderEnd(bytes: Uint8Array): number {
  const marker = textToBytes(HEADER_SEPARATOR);
  for (let i = 0; i + marker.length <= bytes.length; i++) {
    if (marker.every((b, j) => bytes[i + j] === b)) return i;
  }
  return -1;
}

function serializeHttpRequest(hostName: string, path: string, body: Uint8Array): Uint8Array {
  const head =
    `POST ${path} HTTP/1.1\r\n` +
    `host: ${hostName}\r\n` +
    `content-type: ${DOH_CONTENT_TYPE}\r\n` +
    `accept: ${DOH_CONTENT_TYPE}\r\n` +
    `content-length: ${body.length}${HEADER_SEPARATOR}`;
  return Uint8Array.from([...textToBytes(head), ...body]);
}

function serializeHttpResponse(status: number, reason: string, body: Uint8Array): Uint8Array {
  const head =
    `HTTP/1.1 ${status} ${reason}\r\n` +
    `content-type: ${DOH_CONTENT_TYPE}\r\n` +
    `content-length: ${body.length}${HEADER_SEPARATOR}`;
  return Uint8Array.from([...textToBytes(head), ...body]);
}

function parseHttpRequest(bytes: Uint8Array): HttpRequest | null {
  const headerEnd = findHeaderEnd(bytes);
  if (headerEnd === -1) return null;

  const lines = bytesToText(bytes.slice(0, headerEnd)).split('\r\n');
  const [method, path] = lines[0].split(' ');
  if (!method || !path) return null;

  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { method, path, headers, body: bytes.slice(headerEnd + HEADER_SEPARATOR.length) };
}

function parseHttpResponse(bytes: Uint8Array): { status: number; body: Uint8Array } | null {
  const headerEnd = findHeaderEnd(bytes);
  if (headerEnd === -1) return null;

  const statusLine = bytesToText(bytes.slice(0, headerEnd)).split('\r\n')[0];
  const status = parseInt(statusLine.split(' ')[1], 10);
  if (Number.isNaN(status)) return null;

  return { status, body: bytes.slice(headerEnd + HEADER_SEPARATOR.length) };
}

export function bindDnsHttpsServer(host: EndHost, handler: DnsMessageHandler, options: DohOptions = {}): void {
  const path = options.path ?? DOH_PATH;
  bindTlsByteService(host, options.port ?? DOH_PORT, DOH_ALPN, (requestBytes) => {
    const request = parseHttpRequest(requestBytes);
    if (!request || request.method !== 'POST') {
      return serializeHttpResponse(400, 'Bad Request', new Uint8Array());
    }
    if (request.path !== path) {
      return serializeHttpResponse(404, 'Not Found', new Uint8Array());
    }
    if (request.headers.get('content-type') !== DOH_CONTENT_TYPE) {
      return serializeHttpResponse(415, 'Unsupported Media Type', new Uint8Array());
    }
    let query: DnsMessage;
    try {
      query = decodeDnsMessage(request.body);
    } catch {
      return serializeHttpResponse(400, 'Bad Request', new Uint8Array());
    }
    return serializeHttpResponse(200, 'OK', encodeDnsMessage(handler(query)));
  });
}

export function unbindDnsHttpsServer(host: EndHost, port: number = DOH_PORT): void {
  unbindTlsByteService(host, port);
}

export async function queryDnsOverHttps(
  host: EndHost,
  serverIP: IPAddress,
  query: DnsMessage,
  options: DohOptions = {},
): Promise<DnsMessage | null> {
  const request = serializeHttpRequest(
    options.sni ?? serverIP.toString(),
    options.path ?? DOH_PATH,
    encodeDnsMessage(query),
  );
  const responseBytes = await sendTlsRequest(
    host, serverIP.toString(), options.port ?? DOH_PORT, DOH_ALPN, request,
    { sni: options.sni, timeoutMs: options.timeoutMs },
  );
  if (!responseBytes) return null;

  const response = parseHttpResponse(responseBytes);
  if (!response || response.status !== 200) return null;
  try {
    const message = decodeDnsMessage(response.body);
    return message.id === query.id ? message : null;
  } catch {
    return null;
  }
}
