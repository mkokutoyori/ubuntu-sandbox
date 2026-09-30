import type { IPAddress, IPv6Address } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import { RRType } from '@/network/dns/wire/RRType';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { findOpt, CLASSIC_UDP_PAYLOAD_SIZE, DEFAULT_EDNS_PAYLOAD_SIZE } from '@/network/dns/wire/EdnsOptRecord';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';

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
}

export function udpClientOf(host: EndHost): DnsUdpClient {
  return {
    allocateEphemeralPort: () => host.getSocketTable().allocateEphemeralPort(),
    udpBind: (port, listener, processName) => host.udpBind(port, listener, processName),
    udpClose: (port) => host.udpClose(port),
    sendUdpDatagramTo: (ip, dstPort, srcPort, payload, bytes) =>
      host.sendUdpDatagramTo(ip, dstPort, srcPort, payload, bytes ?? payload.length),
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

function negotiatedUdpSize(query: DnsMessage): number {
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
): void {
  if (port === DNS_PORT) host.getSocketTable().unbind('udp', '127.0.0.53', port);
  host.udpBind(port, ({ sourceIP, udp }) => {
    if (!(udp.payload instanceof Uint8Array)) return;
    let query: DnsMessage;
    try {
      query = decodeDnsMessage(udp.payload);
    } catch {
      return;
    }
    if (query.flags.qr) return;
    const send = (result: DnsMessage): void => {
      const response = truncateForUdp(result, negotiatedUdpSize(query));
      const bytes = encodeDnsMessage(response);
      host.sendUdpDatagramTo(sourceIP, udp.sourcePort, port, bytes, bytes.length);
    };
    const result = handler(query, sourceIP, udp.sourcePort, udp.payload);
    if (result instanceof Promise) void result.then(send);
    else send(result);
  }, processName);
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
): Promise<DnsMessage | null> {
  return askOverUdp(udpClientOf(host), serverIP, query, port, timeoutMs, encode);
}

export function askOverUdp(
  host: DnsUdpClient,
  serverIP: IPAddress | IPv6Address,
  query: DnsMessage,
  port: number = DNS_PORT,
  timeoutMs: number = 2000,
  encode: DnsMessageEncoder = encodeDnsMessage,
): Promise<DnsMessage | null> {
  let sourcePort: number;
  try {
    sourcePort = host.allocateEphemeralPort();
  } catch {
    return Promise.resolve(null);
  }

  return new Promise<DnsMessage | null>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const finish = (result: DnsMessage | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      host.udpClose(sourcePort);
      resolve(result);
    };

    try {
      host.udpBind(sourcePort, ({ sourceIP, udp }) => {
        if (!(udp.payload instanceof Uint8Array)) return;
        if (sourceIP.toString() !== serverIP.toString() || udp.sourcePort !== port) return;
        try {
          const response = decodeDnsMessage(udp.payload);
          if (answersQuestion(query, response)) finish(response);
        } catch {
          return;
        }
      }, 'dns-client');
    } catch {
      resolve(null);
      return;
    }

    const bytes = encode(query);
    const sent = host.sendUdpDatagramTo(serverIP, port, sourcePort, bytes, bytes.length);
    if (!sent) {
      finish(null);
      return;
    }
    timer = setTimeout(() => finish(null), timeoutMs);
  });
}
