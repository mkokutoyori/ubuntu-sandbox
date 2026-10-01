import { IPAddress } from '@/network/core/types';
import type { IPv6Address } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { DNS_PORT, queryDnsOverUdp, answersQuestion } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsMessageHandler } from '@/network/dns/transport/DnsUdpTransport';
import { DnsStreamReader, frameDnsMessage } from '@/network/dns/transport/DnsStreamFraming';

export const DNS_TCP_IDLE_TIMEOUT_MS = 10000;

export type DnsStreamHandler = (
  query: DnsMessage,
  sourceIP?: IPAddress | IPv6Address,
  sourcePort?: number,
  raw?: Uint8Array,
) => DnsMessage | readonly DnsMessage[] | Promise<DnsMessage | readonly DnsMessage[]>;

export function bindDnsTcpServer(
  host: EndHost,
  handler: DnsStreamHandler,
  port: number = DNS_PORT,
  options: { address?: string; processName?: string } = {},
): void {
  host.getTcpStack().listen(port, {
    identity: { processName: options.processName ?? 'dnsmasq' },
    onAccept: (socket: TcpSocket) => {
      const reader = new DnsStreamReader();
      let idle: ReturnType<typeof setTimeout> | null = null;
      const rearm = (): void => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => socket.close(), DNS_TCP_IDLE_TIMEOUT_MS);
      };
      socket.onClose(() => { if (idle) clearTimeout(idle); });
      rearm();
      socket.onData((data) => {
        if (!(data instanceof Uint8Array)) return;
        rearm();
        for (const raw of reader.push(data)) {
          let query: DnsMessage;
          try {
            query = decodeDnsMessage(raw);
          } catch {
            socket.close();
            return;
          }
          if (query.flags.qr) {
            socket.close();
            return;
          }
          const send = (response: DnsMessage | readonly DnsMessage[]): void => {
            const messages = Array.isArray(response) ? response : [response as DnsMessage];
            for (const message of messages) socket.send(frameDnsMessage(encodeDnsMessage(message)));
          };
          const result = handler(
            query, IPAddress.tryParse(socket.remoteIp) ?? undefined, socket.remotePort, raw,
          );
          if (result instanceof Promise) void result.then(send);
          else send(result);
        }
      });
    },
  }, options.address ?? '0.0.0.0');
}

export function unbindDnsTcpServer(host: EndHost, port: number = DNS_PORT, address = '0.0.0.0'): void {
  host.getTcpStack().closeListener(port, address);
}

export interface DnsTcpClient {
  tcpConnect(destination: string, port: number): Promise<TcpSocket | null>;
}

function connectWithin(
  host: DnsTcpClient, destination: string, port: number, timeoutMs: number,
): Promise<TcpSocket | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { settled = true; resolve(null); }, timeoutMs);
    host.tcpConnect(destination, port).then(
      (socket) => {
        if (settled) { socket?.close(); return; }
        settled = true;
        clearTimeout(timer);
        resolve(socket);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export async function queryDnsOverTcp(
  host: DnsTcpClient,
  serverIP: IPAddress | IPv6Address,
  query: DnsMessage,
  port: number = DNS_PORT,
  timeoutMs: number = 2000,
): Promise<DnsMessage | null> {
  const socket = await connectWithin(host, serverIP.toString(), port, timeoutMs);
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

    const reader = new DnsStreamReader();
    socket.onData((data) => {
      if (!(data instanceof Uint8Array)) return;
      for (const raw of reader.push(data)) {
        let response: DnsMessage;
        try {
          response = decodeDnsMessage(raw);
        } catch {
          finish(null);
          socket.close();
          return;
        }
        if (!answersQuestion(query, response)) continue;
        finish(response);
        socket.close();
        return;
      }
    });
    socket.onClose(() => finish(null));

    socket.send(frameDnsMessage(encodeDnsMessage(query)));
    timer = setTimeout(() => { finish(null); socket.close(); }, timeoutMs);
  });
}

export async function queryDnsOverTcpStream(
  host: DnsTcpClient,
  serverIP: IPAddress | IPv6Address,
  query: DnsMessage,
  isComplete: (messages: readonly DnsMessage[]) => boolean,
  port: number = DNS_PORT,
  timeoutMs: number = 2000,
): Promise<{ messages: DnsMessage[]; frames: Uint8Array[] } | null> {
  const socket = await connectWithin(host, serverIP.toString(), port, timeoutMs);
  if (!socket) return null;

  return new Promise((resolve) => {
    const messages: DnsMessage[] = [];
    const frames: Uint8Array[] = [];
    const reader = new DnsStreamReader();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: { messages: DnsMessage[]; frames: Uint8Array[] } | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
      socket.close();
    };
    socket.onData((data) => {
      if (!(data instanceof Uint8Array)) return;
      for (const raw of reader.push(data)) {
        let message: DnsMessage;
        try {
          message = decodeDnsMessage(raw);
        } catch {
          finish(null);
          return;
        }
        if (!answersQuestion(query, message)) continue;
        messages.push(message);
        frames.push(raw);
        if (isComplete(messages)) { finish({ messages, frames }); return; }
      }
    });
    socket.onClose(() => finish(null));
    socket.send(frameDnsMessage(encodeDnsMessage(query)));
    if (!settled) timer = setTimeout(() => finish(null), timeoutMs);
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
