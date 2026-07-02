import { IPAddress } from '@/network/core/types';
import type { IPv6Address } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { DNS_PORT, queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsMessageHandler } from '@/network/dns/transport/DnsUdpTransport';

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
        const send = (response: DnsMessage): void => {
          socket.send(encodeDnsMessage(response));
          socket.close();
        };
        const result = handler(query, IPAddress.tryParse(socket.remoteIp) ?? undefined);
        if (result instanceof Promise) void result.then(send);
        else send(result);
      });
    },
  });
}

export function unbindDnsTcpServer(host: EndHost, port: number = DNS_PORT): void {
  host.getTcpStack().closeListener(port);
}

export async function queryDnsOverTcp(
  host: EndHost,
  serverIP: IPAddress | IPv6Address,
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

export async function queryAuthoritativeServer(
  host: EndHost,
  serverIP: IPAddress | IPv6Address,
  query: DnsMessage,
  opts: { port?: number; timeoutMs?: number } = {},
): Promise<DnsMessage | null> {
  const port = opts.port ?? DNS_PORT;
  const timeoutMs = opts.timeoutMs ?? 2000;

  const udpResponse = await queryDnsOverUdp(host, serverIP, query, port, timeoutMs);
  if (!udpResponse || !udpResponse.flags.tc) return udpResponse;

  return queryDnsOverTcp(host, serverIP, query, port, timeoutMs);
}
