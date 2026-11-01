import type { IPAddress, IPv6Address } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import { RRType } from '@/network/dns/wire/RRType';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { findOpt, CLASSIC_UDP_PAYLOAD_SIZE, DEFAULT_EDNS_PAYLOAD_SIZE } from '@/network/dns/wire/EdnsOptRecord';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';
import { observedExchange, type DnsPacketObserver } from '@/network/dns/transport/DnsPacketObserver';

export const CLASSIC_UDP_MAX_SIZE = CLASSIC_UDP_PAYLOAD_SIZE;

export const DNS_PORT = 53;

export type DnsMessageHandler = (
  query: DnsMessage,
  sourceIP?: IPAddress | IPv6Address,
  sourcePort?: number,
  raw?: Uint8Array,
) => DnsMessage | Promise<DnsMessage>;

export function answersQuestion(query: DnsMessage, response: DnsMessage): boolean {
  if (response.id !== query.id) return false;
  if (response.questions.length === 0) return response.flags.rcode === 1;
  if (response.questions.length !== query.questions.length) return false;
  return query.questions.every((asked, index) => {
    const echoed = response.questions[index];
    return echoed.qname.toLowerCase().replace(/\.$/, '') === asked.qname.toLowerCase().replace(/\.$/, '')
      && echoed.qtype === asked.qtype && echoed.qclass === asked.qclass;
  });
}

export type DnsMessageEncoder = (message: DnsMessage) => Uint8Array;

export interface DnsUdpClient {
  allocateEphemeralPort(): number;
  udpBind(
    port: number,
    listener: (delivery: {
      readonly sourceIP: { toString(): string };
      readonly udp: { readonly payload: unknown; readonly sourcePort: number };
    }) => void,
    processName?: string,
  ): number | false;
  udpClose(port: number): void;
  sendUdpDatagramTo(
    destinationIP: IPAddress | IPv6Address,
    destinationPort: number,
    sourcePort: number,
    payload: Uint8Array,
    payloadBytes?: number,
  ): boolean;
  udpConnect(
    remote: IPAddress | IPv6Address,
    remotePort: number,
    options: {
      readonly onDatagram: (delivery: {
        readonly sourceIP: { toString(): string };
        readonly udp: { readonly payload: unknown; readonly sourcePort: number };
      }) => void;
      readonly processName: string;
    },
  ): { send(payload: Uint8Array): string | null; peekError(): string | null; close(): void } | string;
}

export function udpClientOf(host: EndHost): DnsUdpClient {
  return {
    allocateEphemeralPort: () => host.getSocketTable().allocateEphemeralPort(),
    udpBind: (port, listener, processName) => host.udpBind(port, listener, processName),
    udpClose: (port) => host.udpClose(port),
    sendUdpDatagramTo: (ip, dstPort, srcPort, payload, bytes) =>
      host.sendUdpDatagramTo(ip, dstPort, srcPort, payload, bytes ?? payload.length),
    udpConnect: (remote, remotePort, options) => host.udpConnect(remote, remotePort, options),
  };
}

function dropLastRRset(
  records: readonly ResourceRecord<ResourceRecordData>[],
): ResourceRecord<ResourceRecordData>[] {
  if (records.length === 0) return [];
  const last = records[records.length - 1];
  const sameSet = (rr: ResourceRecord<ResourceRecordData>): boolean =>
    rr.name.toLowerCase() === last.name.toLowerCase() && rr.data.type === last.data.type;
  return records.filter((rr) => !sameSet(rr));
}

export function truncateForUdp(message: DnsMessage, maxSize: number = CLASSIC_UDP_PAYLOAD_SIZE): DnsMessage {
  if (encodeDnsMessage(message).length <= maxSize) return message;

  const opt = message.additionals.find((rr) => rr.data.type === RRType.OPT);
  let { answers, authorities } = message;
  let extras = message.additionals.filter((rr) => rr.data.type !== RRType.OPT);
  let truncated = false;

  const rebuild = (): DnsMessage => ({
    ...message,
    flags: { ...message.flags, tc: truncated },
    answers,
    authorities,
    additionals: opt ? [...extras, opt] : extras,
  });
  const fits = (): boolean => encodeDnsMessage(rebuild()).length <= maxSize;

  while (extras.length > 0 && !fits()) extras = dropLastRRset(extras);
  while (authorities.length > 0 && !fits()) {
    authorities = dropLastRRset(authorities);
    truncated = true;
  }
  while (answers.length > 0 && !fits()) {
    answers = answers.slice(0, -1);
    truncated = true;
  }
  if (!fits()) truncated = true;

  return rebuild();
}

export function negotiatedUdpSize(query: DnsMessage): number {
  const opt = findOpt(query);
  if (!opt) return CLASSIC_UDP_PAYLOAD_SIZE;
  return Math.min(
    Math.max(opt.data.udpPayloadSize, CLASSIC_UDP_PAYLOAD_SIZE),
    DEFAULT_EDNS_PAYLOAD_SIZE,
  );
}

export function bindDnsUdpServer(
  host: EndHost,
  handler: DnsMessageHandler,
  port: number = DNS_PORT,
  processName: string = 'dns',
  address?: string,
  boundDevice?: string,
  owner: { pid?: number; service?: string } = {},
  observer?: DnsPacketObserver,
): void {
  if (port === DNS_PORT && address === undefined) host.getSocketTable().unbind('udp', '127.0.0.53', port);
  const bind = (listener: Parameters<EndHost['udpBind']>[1]): void => {
    if (address === undefined) host.udpBind(port, listener, processName, owner);
    else host.udpBindAddress(address, port, listener, processName, boundDevice);
  };
  bind(({ sourceIP, udp }) => {
    if (!(udp.payload instanceof Uint8Array)) return;
    let query: DnsMessage;
    try {
      query = decodeDnsMessage(udp.payload);
    } catch {
      return;
    }
    if (query.flags.qr) return;
    const exchange = {};
    const remote = sourceIP.toString();
    observer?.({ direction: 'receive', transport: 'udp', remote, message: query, exchange });
    const send = (result: DnsMessage): void => {
      const response = truncateForUdp(result, negotiatedUdpSize(query));
      const bytes = encodeDnsMessage(response);
      observer?.({ direction: 'send', transport: 'udp', remote, message: response, exchange });
      host.sendUdpDatagramTo(sourceIP, udp.sourcePort, port, bytes, bytes.length);
    };
    const result = handler(query, sourceIP, udp.sourcePort, udp.payload);
    if (result instanceof Promise) void result.then(send);
    else send(result);
  });
}

export function unbindDnsUdpServer(host: EndHost, port: number = DNS_PORT): void {
  host.udpClose(port);
}

export function queryDnsOverUdp(
  host: EndHost,
  serverIP: IPAddress | IPv6Address,
  query: DnsMessage,
  port: number = DNS_PORT,
  timeoutMs: number = 2000,
  encode: DnsMessageEncoder = encodeDnsMessage,
  observer?: DnsPacketObserver,
): Promise<DnsMessage | null> {
  return observedExchange(observer, 'udp', serverIP.toString(), query,
    () => askOverUdp(udpClientOf(host), serverIP, query, port, timeoutMs, encode));
}

export type UdpExchangeFailure = 'refused';

export function askOverUdp(
  host: DnsUdpClient,
  serverIP: IPAddress | IPv6Address,
  query: DnsMessage,
  port: number = DNS_PORT,
  timeoutMs: number = 2000,
  encode: DnsMessageEncoder = encodeDnsMessage,
  onFailure?: (failure: UdpExchangeFailure) => void,
): Promise<DnsMessage | null> {
  return new Promise<DnsMessage | null>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    let socket: Exclude<ReturnType<DnsUdpClient['udpConnect']>, string> | null = null;
    const finish = (result: DnsMessage | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket?.close();
      resolve(result);
    };

    const opened = host.udpConnect(serverIP, port, {
      processName: 'dns-client',
      onDatagram: ({ sourceIP, udp }) => {
        if (!(udp.payload instanceof Uint8Array)) return;
        if (sourceIP.toString() !== serverIP.toString() || udp.sourcePort !== port) return;
        try {
          const response = decodeDnsMessage(udp.payload);
          if (answersQuestion(query, response)) finish(response);
        } catch {
          return;
        }
      },
    });
    if (typeof opened === 'string') {
      resolve(null);
      return;
    }
    socket = opened;

    const bytes = encode(query);
    if (opened.send(bytes) !== null) {
      finish(null);
      return;
    }
    if (opened.peekError() === 'ECONNREFUSED') {
      onFailure?.('refused');
      finish(null);
      return;
    }
    timer = setTimeout(() => finish(null), timeoutMs);
  });
}
