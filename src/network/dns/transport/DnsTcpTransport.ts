import { IPAddress, IPv6Address } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import { PortNumber } from '@/network/core/ports/PortNumber';
import { parseDialAddress, type DialAddress } from '@/network/tcp/dial';
import { isDialFailure, type TcpDialFailure } from '@/network/tcp/types';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { DNS_PORT, queryDnsOverUdp, answersQuestion } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsMessageHandler } from '@/network/dns/transport/DnsUdpTransport';
import { DnsStreamReader, frameDnsMessage } from '@/network/dns/transport/DnsStreamFraming';
import type { DnsPacketObserver } from '@/network/dns/transport/DnsPacketObserver';

export const DNS_TCP_IDLE_TIMEOUT_MS = 10000;

export type DnsStreamReply = DnsMessage | readonly DnsMessage[] | null;

export type DnsStreamHandler = (
  query: DnsMessage,
  sourceIP?: IPAddress | IPv6Address,
  sourcePort?: number,
  raw?: Uint8Array,
  destinationIP?: IPAddress | IPv6Address,
) => DnsStreamReply | Promise<DnsStreamReply>;

export function addressOf(text: string): IPAddress | IPv6Address | undefined {
  return IPAddress.tryParse(text) ?? IPv6Address.tryParse(text) ?? undefined;
}

export function bindDnsTcpServer(
  host: EndHost,
  handler: DnsStreamHandler,
  port: number = DNS_PORT,
  options: {
    address?: string; processName?: string; boundDevice?: string; pid?: number; service?: string;
    observer?: DnsPacketObserver; onConnection?: () => void;
  } = {},
): void {
  host.getTcpStack().listen(port, {
    identity: { processName: options.processName ?? 'dnsmasq', pid: options.pid, service: options.service },
    ...(options.boundDevice === undefined ? {} : { boundDevice: options.boundDevice }),
    onAccept: (socket: TcpSocket) => {
      options.onConnection?.();
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
          const exchange = {};
          options.observer?.({ direction: 'receive', transport: 'tcp', remote: socket.remoteIp, message: query, exchange });
          const send = (response: DnsStreamReply): void => {
            if (response === null) return;
            const messages = Array.isArray(response) ? response : [response as DnsMessage];
            for (const message of messages) {
              options.observer?.({ direction: 'send', transport: 'tcp', remote: socket.remoteIp, message, exchange });
              socket.send(frameDnsMessage(encodeDnsMessage(message)));
            }
          };
          const result = handler(query, addressOf(socket.remoteIp), socket.remotePort, raw, addressOf(socket.localIp));
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

export type DnsStreamFailure = 'refused' | 'alpn' | 'tls' | 'eof';

export interface DnsTcpClient {
  tcpConnect(destination: string, port: number): Promise<TcpSocket | null>;
  tcpDial?(destination: DialAddress, port: PortNumber): Promise<TcpSocket | TcpDialFailure>;
}

export async function connectDnsStream(
  host: DnsTcpClient, destination: string, port: number, onFailure?: (failure: DnsStreamFailure) => void,
): Promise<TcpSocket | null> {
  const address = parseDialAddress(destination);
  if (host.tcpDial === undefined || address === null || !PortNumber.isValid(port)) return host.tcpConnect(destination, port);
  const outcome = await host.tcpDial(address, PortNumber.of(port));
  if (!isDialFailure(outcome)) return outcome;
  if (outcome.dialFailed === 'refused') onFailure?.('refused');
  return null;
}

function connectWithin(
  host: DnsTcpClient, destination: string, port: number, timeoutMs: number,
  onFailure?: (failure: DnsStreamFailure) => void,
): Promise<TcpSocket | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { settled = true; resolve(null); }, timeoutMs);
    connectDnsStream(host, destination, port, onFailure).then(
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
  observer?: DnsPacketObserver,
  onFailure?: (failure: DnsStreamFailure) => void,
): Promise<DnsMessage | null> {
  const socket = await connectWithin(host, serverIP.toString(), port, timeoutMs, onFailure);
  if (!socket) return null;
  const exchange = {};
  const remote = serverIP.toString();

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
        observer?.({ direction: 'receive', transport: 'tcp', remote, message: response, exchange });
        finish(response);
        socket.close();
        return;
      }
    });
    socket.onClose(() => finish(null));

    observer?.({ direction: 'send', transport: 'tcp', remote, message: query, exchange });
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
  observer?: DnsPacketObserver,
): Promise<{ messages: DnsMessage[]; frames: Uint8Array[] } | null> {
  const socket = await connectWithin(host, serverIP.toString(), port, timeoutMs);
  if (!socket) return null;
  const exchange = {};
  const remote = serverIP.toString();

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
        observer?.({ direction: 'receive', transport: 'tcp', remote, message, exchange });
        messages.push(message);
        frames.push(raw);
        if (isComplete(messages)) { finish({ messages, frames }); return; }
      }
    });
    socket.onClose(() => finish(null));
    observer?.({ direction: 'send', transport: 'tcp', remote, message: query, exchange });
    socket.send(frameDnsMessage(encodeDnsMessage(query)));
    if (!settled) timer = setTimeout(() => finish(null), timeoutMs);
  });
}

export async function queryAuthoritativeServer(
  host: EndHost,
  serverIP: IPAddress | IPv6Address,
  query: DnsMessage,
  opts: { port?: number; timeoutMs?: number; observer?: DnsPacketObserver } = {},
): Promise<DnsMessage | null> {
  const port = opts.port ?? DNS_PORT;
  const timeoutMs = opts.timeoutMs ?? 2000;

  const udpResponse = await queryDnsOverUdp(host, serverIP, query, port, timeoutMs, undefined, opts.observer);
  if (!udpResponse || !udpResponse.flags.tc) return udpResponse;

  return queryDnsOverTcp(host, serverIP, query, port, timeoutMs, opts.observer);
}
