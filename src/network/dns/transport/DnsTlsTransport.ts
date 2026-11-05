/**
 * DNS over TLS (RFC 7858, TCP/853) — bridges DNS query/response framing
 * onto a real RFC 8446 1-RTT handshake (`TlsClientSession`/
 * `TlsServerSession`, `@/network/tls`) instead of `SimulatedTls.ts`'s
 * symmetric-key stand-in (`PRD-TLS.md` §2.1.14). `DnsQuicTransport.ts`
 * (DoQ) still uses `SimulatedTls.ts` — it migrates under `PRD-QUIC.md`
 * once that engine is ready to carry TLS 1.3 itself.
 *
 * Both sides trust a single well-known CA (`getOrCreateCA(DOT_TRUST_ANCHOR_KEY)`,
 * `@/network/pki/PkiCaRegistry`) — the simulator's equivalent of a public
 * DoT resolver's certificate already being signed by a publicly-trusted
 * root, so no enrollment step is needed before `bindDnsTlsServer`/
 * `queryDnsOverTls` can be used, matching the pre-migration API exactly.
 *
 * Each TLS flight is exchanged as a single `TcpSocket.send()`/`onData()`
 * message (this simulator passes JS values through TCP sockets rather
 * than a real byte stream), so the handshake drives one-for-one like the
 * unit tests in `tls-*.test.ts` — just glued to async socket events
 * instead of a synchronous loop.
 */

import type { IPAddress } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { addressOf, type DnsStreamHandler, type DnsStreamReply } from '@/network/dns/transport/DnsTcpTransport';
import { tlsVerifyFailureText } from '@/network/dns/transport/DnsTlsVerification';
import { getOrCreateCA } from '@/network/pki/PkiCaRegistry';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { ServerIdentity } from '@/network/http/https/ServerTlsToolkit';
import type { TlsProtocolVersion } from '@/network/tls/legacy/legacyCipherSuites';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { fragmentAsRecords, reassembleRecords, type TlsRecord } from '@/network/tls/recordLayer';
import { DnsStreamReader, frameDnsMessage } from '@/network/dns/transport/DnsStreamFraming';

export const DOT_PORT = 853;
export const DOT_ALPN = 'dot';

const DOT_TRUST_ANCHOR_KEY = 'dot-well-known-root';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export interface DotOptions {
  readonly port?: number;
  readonly alpn?: string;
  readonly sni?: string;
  readonly serverName?: string;
  readonly timeoutMs?: number;
  readonly identity?: ServerIdentity;
  readonly protocols?: readonly TlsProtocolVersion[];
  readonly address?: string;
  readonly processName?: string;
  readonly pid?: number;
  readonly service?: string;
  readonly anchors?: readonly X509Certificate[];
  readonly verifyPeer?: boolean;
  readonly onVerifyFailure?: (text: string) => void;
}

function concatenated(parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function framedReply(reply: DnsStreamReply): Uint8Array {
  const messages = reply === null ? [] : Array.isArray(reply) ? reply : [reply as DnsMessage];
  return concatenated(messages.map((message) => frameDnsMessage(encodeDnsMessage(message))));
}

export function bindDnsTlsServer(host: EndHost, handler: DnsStreamHandler, options: DotOptions = {}): void {
  const alpn = options.alpn ?? DOT_ALPN;
  const now = host.getTcpStack().nowMs();
  const identity: ServerIdentity = options.identity ?? (() => {
    const issued = getOrCreateCA(DOT_TRUST_ANCHOR_KEY).issueCertificate({
      subject: `CN=${options.sni ?? host.getHostname()}`, notBefore: now - 1000, notAfter: now + ONE_YEAR_MS,
    });
    return { cert: issued.cert, key: issued.privateKey, chain: [] };
  })();

  host.getTcpStack().listen(options.port ?? DOT_PORT, {
    identity: { processName: options.processName ?? 'dnsmasq', pid: options.pid, service: options.service },
    onAccept: (socket: TcpSocket) => {
      const server = new TlsServerSession({
        serverCert: identity.cert, serverPrivateKey: identity.key, serverChain: identity.chain, alpnProtocols: [alpn],
        ...(options.protocols === undefined ? {} : { protocols: options.protocols }),
      });

      socket.onData((data) => {
        const incoming = data as readonly TlsRecord[];

        if (server.result === 'accept') {
          let query: DnsMessage;
          let raw: Uint8Array;
          try {
            const { plaintext } = reassembleRecords(incoming, true);
            [raw] = new DnsStreamReader().push(plaintext);
            query = decodeDnsMessage(raw);
          } catch {
            socket.close();
            return;
          }
          const send = (reply: DnsStreamReply): void => {
            socket.send(fragmentAsRecords('application_data', framedReply(reply), true));
            socket.close();
          };
          const answer = handler(
            query, addressOf(socket.remoteIp), socket.remotePort, raw, addressOf(socket.localIp),
          );
          if (answer instanceof Promise) void answer.then(send, () => socket.close());
          else send(answer);
          return;
        }
        if (server.result === 'reject') return;

        const reply = server.handle(incoming);
        if (server.result === 'reject') {
          socket.close();
          return;
        }
        // RFC 7301 — this DoT deployment requires exactly `alpn`; a
        // negotiated mismatch (or no match at all) is a hard failure, even
        // though the generic TLS engine treats ALPN as informational.
        // `negotiatedCipherSuite` only becomes non-null once negotiation
        // has actually happened (not yet, mid-HelloRetryRequest).
        if (server.negotiatedCipherSuite !== null && server.negotiatedAlpnProtocol !== alpn) {
          socket.close();
          return;
        }
        if (reply) socket.send(reply);
      });
    },
  }, options.address ?? '0.0.0.0');
}

export function unbindDnsTlsServer(host: EndHost, port: number = DOT_PORT, address = '0.0.0.0'): void {
  host.getTcpStack().closeListener(port, address);
}

export async function queryDnsOverTls(
  host: EndHost,
  serverIP: IPAddress,
  query: DnsMessage,
  options: DotOptions = {},
): Promise<DnsMessage | null> {
  const socket = await host.tcpConnect(serverIP.toString(), options.port ?? DOT_PORT);
  if (!socket) return null;

  const alpn = options.alpn ?? DOT_ALPN;
  const timeoutMs = options.timeoutMs ?? 2000;
  const anchors = options.anchors ?? [getOrCreateCA(DOT_TRUST_ANCHOR_KEY).rootCertificate];
  const verifier = new CertificateVerifier({ trustAnchors: anchors, clock: () => host.getTcpStack().nowMs() });
  const client = new TlsClientSession({
    verifier, alpn: [alpn], allowUntrustedPeer: options.verifyPeer === false,
    ...(options.serverName !== undefined ? { serverName: options.serverName } : {}),
  });

  return new Promise<DnsMessage | null>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const finish = (result: DnsMessage | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    socket.onData((data) => {
      const incoming = data as readonly TlsRecord[];

      if (client.result === 'success') {
        try {
          const { plaintext } = reassembleRecords(incoming, true);
          const [raw] = new DnsStreamReader().push(plaintext);
          const response = decodeDnsMessage(raw);
          finish(response.id === query.id ? response : null);
        } catch {
          finish(null);
        }
        socket.close();
        return;
      }

      const reply = client.handle(incoming);
      if (client.result === 'failure') {
        if (client.peerVerificationReason !== null) {
          options.onVerifyFailure?.(tlsVerifyFailureText(client.peerVerificationReason, client.peerCertificate));
        }
        finish(null);
        socket.close();
        return;
      }
      if (reply) socket.send(reply);
      if (client.result === 'success') {
        socket.send(fragmentAsRecords('application_data', frameDnsMessage(encodeDnsMessage(query)), true));
      }
    });
    socket.onClose(() => finish(null));

    socket.send(client.start());
    timer = setTimeout(() => {
      finish(null);
      socket.close();
    }, timeoutMs);
  });
}
