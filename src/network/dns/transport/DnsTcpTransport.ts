import type { IPAddress } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { DNS_PORT, queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsMessageHandler } from '@/network/dns/transport/DnsUdpTransport';

/**
 * Bind a TCP/53 (or custom port) responder on `host` backed by `handler`.
 * One connection answers exactly one query, then closes — a real DNS
 * server keeps the connection open for pipelined queries, but nothing in
 * this simulator yet needs more than the single AXFR/truncation-retry
 * request per connection RFC 1035 §4.2.2 requires as a minimum.
 */
export function bindDnsTcpServer(host: EndHost, handler: DnsMessageHandler, port: number = DNS_PORT): void {
  host.getTcpStack().listen(port, {
    onAccept: (socket: TcpSocket) => {
      socket.onData((data) => {
        if (!(data instanceof Uint8Array)) return;
        let query: DnsMessage;
        try {
          query = decodeDnsMessage(data);
        } catch {
          socket.close();
          return;
        }
        const response = handler(query);
        socket.send(encodeDnsMessage(response));
        socket.close();
      });
    },
  });
}

export function unbindDnsTcpServer(host: EndHost, port: number = DNS_PORT): void {
  host.getTcpStack().closeListener(port);
}

/** Send a binary-encoded DNS query over TCP and await the binary-decoded reply. */
export async function queryDnsOverTcp(
  host: EndHost,
  serverIP: IPAddress,
  query: DnsMessage,
  port: number = DNS_PORT,
  timeoutMs: number = 2000,
): Promise<DnsMessage | null> {
  const socket = await host.tcpConnect(serverIP.toString(), port);
  if (!socket) return null;

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
      if (!(data instanceof Uint8Array)) return;
      try {
        finish(decodeDnsMessage(data));
      } catch {
        finish(null);
      }
      socket.close();
    });
    socket.onClose(() => finish(null));

    socket.send(encodeDnsMessage(query));
    timer = setTimeout(() => { finish(null); socket.close(); }, timeoutMs);
  });
}

/**
 * RFC 1035 §4.2.1: query over UDP first; if the reply comes back truncated
 * (TC=1), repeat the exact same query over TCP and use that response
 * instead — the standard stub-resolver transport-selection algorithm,
 * reused by every DNS client on top of this engine (dig et al., §5 Phase 9).
 */
export async function queryAuthoritativeServer(
  host: EndHost,
  serverIP: IPAddress,
  query: DnsMessage,
  opts: { port?: number; timeoutMs?: number } = {},
): Promise<DnsMessage | null> {
  const port = opts.port ?? DNS_PORT;
  const timeoutMs = opts.timeoutMs ?? 2000;

  const udpResponse = await queryDnsOverUdp(host, serverIP, query, port, timeoutMs);
  if (!udpResponse || !udpResponse.flags.tc) return udpResponse;

  return queryDnsOverTcp(host, serverIP, query, port, timeoutMs);
}
