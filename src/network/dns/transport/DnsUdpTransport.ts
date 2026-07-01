import type { IPAddress } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

/** RFC 1035 §4.2.1: the historical maximum UDP DNS message size without EDNS(0). */
export const CLASSIC_UDP_MAX_SIZE = 512;

export const DNS_PORT = 53;

export type DnsMessageHandler = (query: DnsMessage) => DnsMessage;

/**
 * Trim a response to fit a UDP-sized reply, RFC 1035 §4.2.1: drop whole
 * RRs from the end of the additional section, then authority, then answer,
 * until it fits — setting TC=1 whenever anything was removed so the client
 * knows to retry over TCP.
 */
export function truncateForUdp(message: DnsMessage, maxSize: number = CLASSIC_UDP_MAX_SIZE): DnsMessage {
  if (encodeDnsMessage(message).length <= maxSize) return message;

  let { answers, authorities, additionals } = message;
  const fits = (): boolean =>
    encodeDnsMessage({ ...message, answers, authorities, additionals }).length <= maxSize;

  while (additionals.length > 0 && !fits()) additionals = additionals.slice(0, -1);
  while (authorities.length > 0 && !fits()) authorities = authorities.slice(0, -1);
  while (answers.length > 0 && !fits()) answers = answers.slice(0, -1);

  return { ...message, flags: { ...message.flags, tc: true }, answers, authorities, additionals };
}

/** Bind a UDP/53 (or custom port) responder on `host` backed by `handler`. */
export function bindDnsUdpServer(host: EndHost, handler: DnsMessageHandler, port: number = DNS_PORT): void {
  // Like real dnsmasq/named on Ubuntu, taking over port 53 supersedes the
  // systemd-resolved stub listener on 127.0.0.53 rather than conflicting with it.
  if (port === DNS_PORT) host.getSocketTable().unbind('udp', '127.0.0.53', port);
  host.udpBind(port, ({ sourceIP, udp }) => {
    if (!(udp.payload instanceof Uint8Array)) return;
    let query: DnsMessage;
    try {
      query = decodeDnsMessage(udp.payload);
    } catch {
      return;
    }
    const response = truncateForUdp(handler(query));
    const bytes = encodeDnsMessage(response);
    host.sendUdpDatagram(sourceIP, udp.sourcePort, port, bytes, bytes.length);
  }, 'dns');
}

export function unbindDnsUdpServer(host: EndHost, port: number = DNS_PORT): void {
  host.udpClose(port);
}

/**
 * Send a binary-encoded DNS query over UDP and await the binary-decoded
 * reply. Resolves to null on timeout, exactly like a real stub resolver.
 */
export function queryDnsOverUdp(
  host: EndHost,
  serverIP: IPAddress,
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
          // malformed reply: ignore and let the timeout fire
        }
      }, 'dns-client');
    } catch {
      resolve(null);
      return;
    }

    const bytes = encodeDnsMessage(query);
    const sent = host.sendUdpDatagram(serverIP, port, sourcePort, bytes, bytes.length);
    if (!sent) {
      finish(null);
      return;
    }
    timer = setTimeout(() => finish(null), timeoutMs);
  });
}
