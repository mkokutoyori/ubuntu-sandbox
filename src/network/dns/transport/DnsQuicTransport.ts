/**
 * DNS-over-QUIC (RFC 9250), migrated onto the real `QuicConnection`
 * (PRD-QUIC.md §5 P8/P13) instead of the ad hoc "one UDP datagram = one
 * XOR-encrypted DNS message" stand-in this module previously built
 * directly over `SimulatedTls.ts`. Each query opens a new client-initiated
 * bidirectional stream (RFC 9250 §5.1) carrying a length-prefixed DNS
 * message (§4.2, mirroring DNS-over-TCP framing, RFC 1035 §4.2.2); the
 * connection itself is now real and reused across queries rather than
 * rebuilt per request.
 *
 * `QuicConnection` models a single point-to-point connection (bound to
 * one UDP port, no listener/accept fan-out like `TcpStack`) — a
 * limitation already present since P1, not introduced by this migration.
 * `bindDnsQuicServer` therefore serves exactly one concurrent client per
 * bound port, a narrower scope than the old stand-in's implicit
 * multi-client support, but matching this test suite's single-client
 * usage.
 */
import type { IPAddress } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import type { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { DnsMessageHandler } from '@/network/dns/transport/DnsUdpTransport';
import { QuicConnection } from '@/network/quic/QuicConnection';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { TlsServerSession } from '@/network/tls/TlsServerSession';

export const DOQ_PORT = 853;
export const DOQ_ALPN = 'doq';

/**
 * RFC 9001 §5.2 needs a client-chosen destination connection ID to derive
 * Initial secrets; both peers must agree on the same value. Real
 * per-connection negotiation is out of scope here (PRD-QUIC.md §2.2
 * already excludes connection ID rotation beyond the minimum), so DoQ
 * uses one fixed value, consistent with binding exactly one client per
 * server instance.
 */
const FIXED_CLIENT_DEST_CONNECTION_ID = 'doq-fixed-dcid';

export interface DoqOptions {
  readonly port?: number;
  readonly timeoutMs?: number;
}

export interface DoqServerTlsConfig {
  readonly serverCert: X509Certificate;
  readonly serverPrivateKey: PkiPrivateKey;
}

export interface DoqClientTlsConfig {
  readonly verifier: CertificateVerifier;
}

function encodeLengthPrefixedDns(message: DnsMessage): Uint8Array {
  const body = encodeDnsMessage(message);
  const out = new Uint8Array(2 + body.length);
  out[0] = (body.length >> 8) & 0xff;
  out[1] = body.length & 0xff;
  out.set(body, 2);
  return out;
}

function decodeLengthPrefixedDns(bytes: Uint8Array): DnsMessage | null {
  if (bytes.length < 2) return null;
  const length = (bytes[0] << 8) | bytes[1];
  if (bytes.length < 2 + length) return null;
  try {
    return decodeDnsMessage(bytes.slice(2, 2 + length));
  } catch {
    return null;
  }
}

const runningServers = new Map<string, QuicConnection>();

export function bindDnsQuicServer(
  host: EndHost, handler: DnsMessageHandler, tlsConfig: DoqServerTlsConfig, options: DoqOptions = {},
): void {
  const port = options.port ?? DOQ_PORT;
  const serverTls = new TlsServerSession({
    serverCert: tlsConfig.serverCert, serverPrivateKey: tlsConfig.serverPrivateKey, alpnProtocols: [DOQ_ALPN],
  });
  const conn = new QuicConnection(host, 'server', port, {
    mode: 'tls', tls: serverTls, clientDestConnectionId: FIXED_CLIENT_DEST_CONNECTION_ID,
  });

  conn.onMessage((msg) => {
    if (!msg.fin) return;
    const query = decodeLengthPrefixedDns(msg.data);
    if (!query) return;
    const response = handler(query);
    if (response instanceof Promise) return;
    conn.sendData(msg.streamId, encodeLengthPrefixedDns(response), true);
  });

  runningServers.set(`${host.id}:${port}`, conn);
}

export function unbindDnsQuicServer(host: EndHost, port: number = DOQ_PORT): void {
  runningServers.delete(`${host.id}:${port}`);
  host.udpClose(port);
}

/**
 * RFC 9250 §5.1 — one real, reused QUIC connection; `query()` opens a new
 * client-initiated bidirectional stream per request instead of rebuilding
 * the whole connection each time.
 */
export class DnsQuicClient {
  private conn: QuicConnection | null = null;
  lastStreamId = -1;

  constructor(
    private readonly host: EndHost,
    private readonly serverIP: IPAddress,
    private readonly tlsConfig: DoqClientTlsConfig,
    private readonly options: DoqOptions = {},
  ) {}

  private connectIfNeeded(): boolean {
    if (this.conn && this.conn.state === 'established') return true;
    const clientTls = new TlsClientSession({ verifier: this.tlsConfig.verifier, alpn: [DOQ_ALPN] });
    const conn = new QuicConnection(this.host, 'client', this.options.port ?? DOQ_PORT, {
      mode: 'tls', tls: clientTls, clientDestConnectionId: FIXED_CLIENT_DEST_CONNECTION_ID,
    });
    conn.connect(this.serverIP.toString(), this.options.port ?? DOQ_PORT);
    if (conn.state !== 'established') return false;
    this.conn = conn;
    return true;
  }

  async query(message: DnsMessage): Promise<DnsMessage | null> {
    if (!this.connectIfNeeded() || !this.conn) return null;
    const conn = this.conn;

    const streamId = conn.openStream('bidirectional');
    this.lastStreamId = streamId;

    let responseBytes: Uint8Array | null = null;
    const unsubscribe = conn.onMessage((msg) => {
      if (msg.streamId === streamId && msg.fin) responseBytes = msg.data;
    });
    conn.sendData(streamId, encodeLengthPrefixedDns(message), true);
    unsubscribe();

    if (!responseBytes) return null;
    const response = decodeLengthPrefixedDns(responseBytes);
    return response && response.id === message.id ? response : null;
  }
}

export async function queryDnsOverQuic(
  host: EndHost, serverIP: IPAddress, query: DnsMessage, tlsConfig: DoqClientTlsConfig, options: DoqOptions = {},
): Promise<DnsMessage | null> {
  return new DnsQuicClient(host, serverIP, tlsConfig, options).query(query);
}
