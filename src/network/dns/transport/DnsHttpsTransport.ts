/**
 * DNS-over-HTTPS (RFC 8484), migrated onto the shared HTTP/1.1 + HTTPS
 * engine (PRD-HTTP.md §5 P7/P13) instead of the hand-rolled framing this
 * module previously built directly over `SimulatedTls.ts`. A real TLS 1.3
 * handshake now backs every query, so the caller must supply real PKI
 * material (a server certificate/key to bind, a `CertificateVerifier` to
 * query) — `SimulatedTls.ts`'s stand-in handshake had none.
 */
import type { IPAddress, IPv6Address } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import type { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { base64ToBytes, bytesToBase64 } from '@/crypto/encoding';
import { RRType } from '@/network/dns/wire/RRType';
import { addressOf, connectDnsStream, type DnsStreamFailure, type DnsStreamHandler } from '@/network/dns/transport/DnsTcpTransport';
import { tlsVerifyFailureText } from '@/network/dns/transport/DnsTlsVerification';
import { createRequest, createResponse } from '@/network/http/semantics/types';
import { HttpsClientSession, type HttpsSendResult } from '@/network/http/https/HttpsClientSession';
import { HttpsServerSession } from '@/network/http/https/HttpsServerSession';
import type { Http1RequestHandler } from '@/network/http/http1/Http1ServerSession';
import { Http2ServerSession } from '@/network/http/http2/Http2ServerSession';
import { Http2ClientSession, type Http2SendResult } from '@/network/http/http2/Http2ClientSession';
import { HTTP2_DEFAULT_MAX_CONCURRENT_STREAMS } from '@/network/http/http2/Http2Connection';
import { ConnectionQuota } from '@/network/tcp/ConnectionQuota';
import type { TlsProtocolVersion } from '@/network/tls/legacy/legacyCipherSuites';
import { dnsTlsServerOptions, type DnsTlsServerSettings } from '@/network/dns/transport/DnsTlsServerSettings';

export const DOH_PORT = 443;
export const DOH_PLAIN_PORT = 80;
export const DOH_ALPN = 'h2';
export const DOH_PATH = '/dns-query';
export const DOH_CONTENT_TYPE = 'application/dns-message';

export interface DohOptions {
  readonly port?: number;
  readonly path?: string;
  readonly paths?: readonly string[];
  readonly sni?: string;
  readonly timeoutMs?: number;
  readonly method?: 'GET' | 'POST';
  readonly address?: string;
  readonly processName?: string;
  readonly pid?: number;
  readonly service?: string;
  readonly onVerifyFailure?: (text: string) => void;
  readonly onHttpStatus?: (status: number) => void;
  readonly onStreamFailure?: (failure: DnsStreamFailure) => void;
  readonly plain?: boolean;
  readonly listenerClients?: number;
  readonly streamsPerConnection?: number;
  readonly silentRejection?: boolean;
}

export interface DohServerTlsConfig {
  readonly serverCert: X509Certificate;
  readonly serverPrivateKey: PkiPrivateKey;
  readonly serverChain?: readonly X509Certificate[];
  readonly protocols?: readonly TlsProtocolVersion[];
  readonly settings?: DnsTlsServerSettings;
}

export interface DohClientIdentity {
  readonly certificate: X509Certificate;
  readonly chain: readonly X509Certificate[];
  readonly privateKey: PkiPrivateKey;
}

export interface DohClientTlsConfig {
  readonly identity?: DohClientIdentity;
  readonly verifier: CertificateVerifier;
  readonly verifyPeer?: boolean;
  readonly serverName?: string;
}

function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function freshnessLifetime(message: DnsMessage): number {
  const cacheable = message.answers.length > 0
    ? message.answers
    : message.authorities.filter((rr) => rr.data.type === RRType.SOA);
  if (cacheable.length === 0) return 0;
  return Math.min(...cacheable.map((rr) =>
    rr.data.type === RRType.SOA ? Math.min(rr.ttl, rr.data.minimum) : rr.ttl));
}

const runningServers = new Map<string, HttpsServerSession>();

function streamLimits(options: DohOptions): { localSettings: { maxConcurrentStreams: number } } {
  return { localSettings: { maxConcurrentStreams: options.streamsPerConnection ?? HTTP2_DEFAULT_MAX_CONCURRENT_STREAMS } };
}

function quotaOf(options: DohOptions): ConnectionQuota | undefined {
  return options.listenerClients === undefined || options.listenerClients === 0 ? undefined : new ConnectionQuota(options.listenerClients);
}

function dohRequestHandler(handler: DnsStreamHandler, paths: readonly string[]): Http1RequestHandler {
  return (request, peer) => {
    const [targetPath, queryString = ''] = request.target.split('?');
    if (!paths.includes(targetPath)) return createResponse(404, 'Not Found');
    if (request.method !== 'GET' && request.method !== 'POST') {
      return createResponse(501, 'Not Implemented');
    }

    let wire: Uint8Array;
    if (request.method === 'POST') {
      if (request.headers.get('Content-Type') !== DOH_CONTENT_TYPE) {
        return createResponse(415, 'Unsupported Media Type');
      }
      wire = request.body ?? new Uint8Array();
    } else {
      const parameter = queryString.split('&').find((part) => part.startsWith('dns='));
      if (parameter === undefined) return createResponse(400, 'Bad Request');
      try {
        wire = base64ToBytes(parameter.slice(4).replace(/-/g, '+').replace(/_/g, '/'));
      } catch {
        return createResponse(400, 'Bad Request');
      }
    }

    let query: DnsMessage;
    try {
      query = decodeDnsMessage(wire);
    } catch {
      return createResponse(400, 'Bad Request');
    }
    if (query.flags.qr) return createResponse(400, 'Bad Request');

    const respond = (reply: DnsMessage | readonly DnsMessage[] | null) => {
      const answer = Array.isArray(reply) ? reply[0] : reply as DnsMessage | null;
      if (answer === null || answer === undefined) return createResponse(500, 'Internal Server Error');
      const response = createResponse(200, 'OK');
      response.headers.set('Content-Type', DOH_CONTENT_TYPE);
      response.headers.set('Cache-Control', `max-age=${freshnessLifetime(answer)}`);
      response.body = encodeDnsMessage(answer);
      return response;
    };
    const answer = handler(query, peer === undefined ? undefined : addressOf(peer.ip), peer?.port, wire);
    return answer instanceof Promise ? answer.then(respond, () => createResponse(500, 'Internal Server Error')) : respond(answer);
  };
}

function listenerIdentity(options: DohOptions): { processName: string; pid: number | undefined; service: string | undefined } {
  return { processName: options.processName ?? 'dnsmasq', pid: options.pid, service: options.service };
}

export function bindDnsHttpsServer(
  host: EndHost, handler: DnsStreamHandler, tlsConfig: DohServerTlsConfig, options: DohOptions = {},
): void {
  const port = options.port ?? DOH_PORT;
  const address = options.address ?? '0.0.0.0';
  const quota = quotaOf(options);
  const server = new HttpsServerSession(
    host.getTcpStack(), port,
    {
      serverCert: tlsConfig.serverCert, serverPrivateKey: tlsConfig.serverPrivateKey,
      ...(tlsConfig.serverChain === undefined ? {} : { serverChain: tlsConfig.serverChain }),
      ...dnsTlsServerOptions(tlsConfig.settings, () => host.getTcpStack().nowMs()),
      ...(tlsConfig.protocols === undefined ? {} : { protocols: tlsConfig.protocols }),
      alpnProtocols: [DOH_ALPN],
      alpnMismatch: 'ignore',
      http2: { only: true, connection: streamLimits(options) },
      silentRejection: options.silentRejection === true,
      ...(quota === undefined ? {} : { quota }),
    },
    dohRequestHandler(handler, options.paths ?? [options.path ?? DOH_PATH]),
  );
  server.start(listenerIdentity(options), undefined, address);
  runningServers.set(`${host.id}:${port}:${address}`, server);
}

const runningPlainServers = new Map<string, Http2ServerSession>();

export function bindDnsHttpServer(host: EndHost, handler: DnsStreamHandler, options: DohOptions = {}): void {
  const port = options.port ?? DOH_PLAIN_PORT;
  const address = options.address ?? '0.0.0.0';
  const server = new Http2ServerSession(
    host.getTcpStack(), port, dohRequestHandler(handler, options.paths ?? [options.path ?? DOH_PATH]),
    streamLimits(options), quotaOf(options),
  );
  server.start(listenerIdentity(options), undefined, address);
  runningPlainServers.set(`${host.id}:${port}:${address}`, server);
}

export function unbindDnsHttpServer(host: EndHost, port: number = DOH_PLAIN_PORT, address = '0.0.0.0'): void {
  const key = `${host.id}:${port}:${address}`;
  runningPlainServers.get(key)?.stop();
  runningPlainServers.delete(key);
}

export function unbindDnsHttpsServer(host: EndHost, port: number = DOH_PORT, address = '0.0.0.0'): void {
  const key = `${host.id}:${port}:${address}`;
  runningServers.get(key)?.stop();
  runningServers.delete(key);
}

export interface DohTarget {
  readonly host: string;
  readonly port: number;
  readonly path: string;
}

export interface DnsHttpsPlan {
  readonly target: DohTarget;
  readonly allowFallbackToUdp: boolean;
  readonly anchors: readonly X509Certificate[];
}

export function parseDohTemplate(template: string): DohTarget | null {
  const match = /^https:\/\/([^/:?#\s]+)(?::(\d{1,5}))?(\/[^?#\s{]*)?/i.exec(template);
  if (match === null) return null;
  const port = match[2] === undefined ? DOH_PORT : Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return { host: match[1], port, path: match[3] ?? DOH_PATH };
}

interface DohExchange {
  readonly request: ReturnType<typeof createRequest>;
  readonly session: HttpsClientSession | Http2ClientSession;
  finish(result: HttpsSendResult | Http2SendResult): DnsMessage | null;
}

function prepareExchange(
  host: EndHost, serverIP: IPAddress | IPv6Address, query: DnsMessage, tlsConfig: DohClientTlsConfig, options: DohOptions,
): DohExchange {
  const address = serverIP.toString();
  const session = options.plain === true
    ? new Http2ClientSession(host.getTcpStack(), address, options.port ?? DOH_PLAIN_PORT)
    : new HttpsClientSession(
      host.getTcpStack(), address, options.port ?? DOH_PORT,
      {
        verifier: tlsConfig.verifier, alpn: [DOH_ALPN], requireAlpn: DOH_ALPN, allowUntrustedPeer: tlsConfig.verifyPeer === false,
        ...(tlsConfig.identity === undefined ? {} : {
          clientCert: tlsConfig.identity.certificate, clientChain: tlsConfig.identity.chain, clientPrivateKey: tlsConfig.identity.privateKey,
        }),
        ...(tlsConfig.serverName === undefined ? {} : { serverName: tlsConfig.serverName }),
      },
    );

  const wire = encodeDnsMessage({ ...query, id: 0 });
  const path = options.path ?? DOH_PATH;
  const request = options.method === 'GET'
    ? createRequest('GET', `${path}?dns=${base64Url(wire)}`)
    : createRequest('POST', path);
  request.headers.set('Host', options.sni ?? (address.includes(':') ? `[${address}]` : address));
  request.headers.set('Accept', DOH_CONTENT_TYPE);
  if (options.method !== 'GET') {
    request.headers.set('Content-Type', DOH_CONTENT_TYPE);
    request.body = wire;
  }

  const finish = (result: HttpsSendResult | Http2SendResult): DnsMessage | null => {
    const handshake = session instanceof HttpsClientSession ? session.handshake : null;
    const failure = session.connectFailure;
    session.close();
    if (!result.ok) {
      if (failure === 'tls' && handshake?.peerVerificationReason != null) {
        options.onVerifyFailure?.(tlsVerifyFailureText(handshake.peerVerificationReason, handshake.peerCertificate, handshake.peerCertificateChain));
      } else if (failure === 'refused' || failure === 'alpn' || failure === 'tls') {
        options.onStreamFailure?.(failure);
      } else if (failure === null) {
        options.onStreamFailure?.('eof');
      }
      return null;
    }
    if (result.response?.statusCode !== 200) {
      options.onHttpStatus?.(result.response?.statusCode ?? 0);
      return null;
    }
    try {
      const message = decodeDnsMessage(result.response.body ?? new Uint8Array());
      return message.id === 0 ? { ...message, id: query.id } : null;
    } catch {
      return null;
    }
  };
  return { request, session, finish };
}

export async function queryDnsOverHttps(
  host: EndHost, serverIP: IPAddress | IPv6Address, query: DnsMessage, tlsConfig: DohClientTlsConfig, options: DohOptions = {},
): Promise<DnsMessage | null> {
  const exchange = prepareExchange(host, serverIP, query, tlsConfig, options);
  const port = options.port ?? (options.plain === true ? DOH_PLAIN_PORT : DOH_PORT);
  const socket = await connectDnsStream(host, serverIP.toString(), port, options.onStreamFailure);
  if (socket === null) return null;
  exchange.session.adopt(socket);
  return exchange.finish(await exchange.session.sendAsync(exchange.request));
}

export function exchangeDnsOverHttps(
  host: EndHost, serverIP: IPAddress | IPv6Address, query: DnsMessage, tlsConfig: DohClientTlsConfig, options: DohOptions = {},
): DnsMessage | null {
  const exchange = prepareExchange(host, serverIP, query, tlsConfig, options);
  return exchange.finish(exchange.session.send(exchange.request));
}
