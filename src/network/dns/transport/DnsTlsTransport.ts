/**
 * DNS over TLS (RFC 7858, TCP/853) — bridges DNS query/response framing
 * onto a real RFC 8446 1-RTT handshake (`TlsClientSession`/
 * `TlsServerSession`, `@/network/tls`) instead of `SimulatedTls.ts`'s
 * symmetric-key stand-in (`PRD-TLS.md` §2.1.14). `DnsHttpsTransport.ts`
 * (DoH) and `DnsQuicTransport.ts` (DoQ) still use `SimulatedTls.ts` — they
 * migrate under `PRD-HTTP.md`/`PRD-QUIC.md` instead, once those engines
 * are ready to carry TLS 1.3 themselves.
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
import type { DnsMessageHandler } from '@/network/dns/transport/DnsUdpTransport';
import { getOrCreateCA } from '@/network/pki/PkiCaRegistry';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { fragmentAsRecords, reassembleRecords, type TlsRecord } from '@/network/tls/recordLayer';

export const DOT_PORT = 853;
export const DOT_ALPN = 'dot';

const DOT_TRUST_ANCHOR_KEY = 'dot-well-known-root';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export interface DotOptions {
  readonly port?: number;
  readonly alpn?: string;
  readonly sni?: string;
  readonly timeoutMs?: number;
}

export function bindDnsTlsServer(host: EndHost, handler: DnsMessageHandler, options: DotOptions = {}): void {
  const alpn = options.alpn ?? DOT_ALPN;
  const ca = getOrCreateCA(DOT_TRUST_ANCHOR_KEY);
  const now = Date.now();
  const issued = ca.issueCertificate({
    subject: `CN=${options.sni ?? host.getHostname()}`, notBefore: now - 1000, notAfter: now + ONE_YEAR_MS,
  });

  host.getTcpStack().listen(options.port ?? DOT_PORT, {
    // DNS-over-TLS (RFC 7858) écoute vraiment ; c'est ce nom qui le dit
    // à `ss`, à la place du `socketTable.bind()` manuel que
    // `bindDnsServerPort()` posait à côté.
    identity: { processName: 'dnsmasq' },
    onAccept: (socket: TcpSocket) => {
      const server = new TlsServerSession({
        serverCert: issued.cert, serverPrivateKey: issued.privateKey, alpnProtocols: [alpn],
      });

      socket.onData((data) => {
        const incoming = data as readonly TlsRecord[];

        if (server.result === 'accept') {
          let query: DnsMessage;
          try {
            const { plaintext } = reassembleRecords(incoming, true);
            query = decodeDnsMessage(plaintext);
          } catch {
            socket.close();
            return;
          }
          const answer = handler(query);
          // This socket callback is synchronous-only — same constraint as
          // DnsQuicTransport/DnsUdpTransport, an async handler result can't
          // be awaited here.
          if (answer instanceof Promise) { socket.close(); return; }
          socket.send(fragmentAsRecords('application_data', encodeDnsMessage(answer), true));
          socket.close();
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
  });
}

export function unbindDnsTlsServer(host: EndHost, port: number = DOT_PORT): void {
  host.getTcpStack().closeListener(port);
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
  const ca = getOrCreateCA(DOT_TRUST_ANCHOR_KEY);
  const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => Date.now() });
  const client = new TlsClientSession({ verifier, alpn: [alpn] });

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
          const response = decodeDnsMessage(plaintext);
          finish(response.id === query.id ? response : null);
        } catch {
          finish(null);
        }
        socket.close();
        return;
      }

      const reply = client.handle(incoming);
      if (client.result === 'failure') {
        finish(null);
        socket.close();
        return;
      }
      if (reply) socket.send(reply);
      if (client.result === 'success') {
        socket.send(fragmentAsRecords('application_data', encodeDnsMessage(query), true));
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
