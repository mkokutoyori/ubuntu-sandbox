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
      if (request.method !== 'POST') return createResponse(400, 'Bad Request');
      if (request.target !== path) return createResponse(404, 'Not Found');
      if (request.headers.get('Content-Type') !== DOH_CONTENT_TYPE) return createResponse(415, 'Unsupported Media Type');

      let query: DnsMessage;
      try {
        query = decodeDnsMessage(request.body ?? new Uint8Array());
      } catch {
        return createResponse(400, 'Bad Request');
      }

      const response = createResponse(200, 'OK');
      response.headers.set('Content-Type', DOH_CONTENT_TYPE);
      response.body = encodeDnsMessage(handler(query));
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
  request.body = encodeDnsMessage(query);

  const result = client.send(request);
  client.close();
  if (!result.ok || result.response?.statusCode !== 200) return null;

  try {
    const message = decodeDnsMessage(result.response.body ?? new Uint8Array());
    return message.id === query.id ? message : null;
  } catch {
    return null;
  }
}
