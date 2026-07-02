import type { IPAddress, IPv6Address } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import { RRType } from '@/network/dns/wire/RRType';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { findOpt, CLASSIC_UDP_PAYLOAD_SIZE, DEFAULT_EDNS_PAYLOAD_SIZE } from '@/network/dns/wire/EdnsOptRecord';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

export const CLASSIC_UDP_MAX_SIZE = CLASSIC_UDP_PAYLOAD_SIZE;

export const DNS_PORT = 53;

export type DnsMessageHandler = (query: DnsMessage, sourceIP?: IPAddress) => DnsMessage;

export function truncateForUdp(message: DnsMessage, maxSize: number = CLASSIC_UDP_PAYLOAD_SIZE): DnsMessage {
  if (encodeDnsMessage(message).length <= maxSize) return message;

  const opt = message.additionals.find((rr) => rr.data.type === RRType.OPT);
  let { answers, authorities } = message;
  let extras = message.additionals.filter((rr) => rr.data.type !== RRType.OPT);

  const rebuild = (): DnsMessage => ({
    ...message,
    flags: { ...message.flags, tc: true },
    answers,
    authorities,
    additionals: opt ? [...extras, opt] : extras,
  });
  const fits = (): boolean => encodeDnsMessage(rebuild()).length <= maxSize;

  while (extras.length > 0 && !fits()) extras = extras.slice(0, -1);
  while (authorities.length > 0 && !fits()) authorities = authorities.slice(0, -1);
  while (answers.length > 0 && !fits()) answers = answers.slice(0, -1);

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
    const response = truncateForUdp(handler(query, sourceIP), negotiatedUdpSize(query));
    const bytes = encodeDnsMessage(response);
    host.sendUdpDatagramTo(sourceIP, udp.sourcePort, port, bytes, bytes.length);
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
): Promise<DnsMessage | null> {
  let sourcePort: number;
  try {
    sourcePort = host.getSocketTable().allocateEphemeralPort();
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
      host.udpBind(sourcePort, ({ udp }) => {
        if (!(udp.payload instanceof Uint8Array)) return;
        try {
          const response = decodeDnsMessage(udp.payload);
          if (response.id === query.id) finish(response);
        } catch {
          return;
        }
      }, 'dns-client');
    } catch {
      resolve(null);
      return;
    }

    const bytes = encodeDnsMessage(query);
    const sent = host.sendUdpDatagramTo(serverIP, port, sourcePort, bytes, bytes.length);
    if (!sent) {
      finish(null);
      return;
    }
    timer = setTimeout(() => finish(null), timeoutMs);
  });
}
