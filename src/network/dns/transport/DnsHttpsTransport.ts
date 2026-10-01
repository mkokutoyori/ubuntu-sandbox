/**
 * DNS-over-HTTPS (RFC 8484), migrated onto the shared HTTP/1.1 + HTTPS
 * engine (PRD-HTTP.md §5 P7/P13) instead of the hand-rolled framing this
 * module previously built directly over `SimulatedTls.ts`. A real TLS 1.3
 * handshake now backs every query, so the caller must supply real PKI
 * material (a server certificate/key to bind, a `CertificateVerifier` to
 * query) — `SimulatedTls.ts`'s stand-in handshake had none.
 */
import type { IPAddress } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import type { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { base64ToBytes } from '@/crypto/encoding';
import { RRType } from '@/network/dns/wire/RRType';
import type { DnsMessageHandler } from '@/network/dns/transport/DnsUdpTransport';
import { createRequest, createResponse } from '@/network/http/semantics/types';
import { HttpsClientSession } from '@/network/http/https/HttpsClientSession';
import { HttpsServerSession } from '@/network/http/https/HttpsServerSession';

export const DOH_PORT = 443;
export const DOH_ALPN = 'http/1.1';
export const DOH_PATH = '/dns-query';
export const DOH_CONTENT_TYPE = 'application/dns-message';

export interface DohOptions {
  readonly port?: number;
  readonly path?: string;
  readonly sni?: string;
  readonly timeoutMs?: number;
}

export interface DohServerTlsConfig {
  readonly serverCert: X509Certificate;
  readonly serverPrivateKey: PkiPrivateKey;
}

export interface DohClientTlsConfig {
  readonly verifier: CertificateVerifier;
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

export function bindDnsHttpsServer(
  host: EndHost, handler: DnsMessageHandler, tlsConfig: DohServerTlsConfig, options: DohOptions = {},
): void {
  const path = options.path ?? DOH_PATH;
  const port = options.port ?? DOH_PORT;

  const server = new HttpsServerSession(
    host.getTcpStack(), port,
    { serverCert: tlsConfig.serverCert, serverPrivateKey: tlsConfig.serverPrivateKey, alpnProtocols: [DOH_ALPN] },
    (request) => {
      const [targetPath, queryString = ''] = request.target.split('?');
      if (targetPath !== path) return createResponse(404, 'Not Found');
      if (request.method !== 'GET' && request.method !== 'POST') {
        const refused = createResponse(405, 'Method Not Allowed');
        refused.headers.set('Allow', 'GET, POST');
        return refused;
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

      const answer = handler(query);
      if (answer instanceof Promise) return createResponse(500, 'Internal Server Error');
      const response = createResponse(200, 'OK');
      response.headers.set('Content-Type', DOH_CONTENT_TYPE);
      response.headers.set('Cache-Control', `max-age=${freshnessLifetime(answer)}`);
      response.body = encodeDnsMessage(answer);
      return response;
    },
  );
  server.start();
  runningServers.set(`${host.id}:${port}`, server);
}

export function unbindDnsHttpsServer(host: EndHost, port: number = DOH_PORT): void {
  const key = `${host.id}:${port}`;
  runningServers.get(key)?.stop();
  runningServers.delete(key);
}

export async function queryDnsOverHttps(
  host: EndHost, serverIP: IPAddress, query: DnsMessage, tlsConfig: DohClientTlsConfig, options: DohOptions = {},
): Promise<DnsMessage | null> {
  const client = new HttpsClientSession(
    host.getTcpStack(), serverIP.toString(), options.port ?? DOH_PORT,
    { verifier: tlsConfig.verifier, alpn: [DOH_ALPN] },
  );

  const request = createRequest('POST', options.path ?? DOH_PATH);
  request.headers.set('Host', options.sni ?? serverIP.toString());
  request.headers.set('Content-Type', DOH_CONTENT_TYPE);
  request.headers.set('Accept', DOH_CONTENT_TYPE);
  request.body = encodeDnsMessage({ ...query, id: 0 });

  const result = client.send(request);
  client.close();
  if (!result.ok || result.response?.statusCode !== 200) return null;

  try {
    const message = decodeDnsMessage(result.response.body ?? new Uint8Array());
    return message.id === 0 ? { ...message, id: query.id } : null;
  } catch {
    return null;
  }
}
