import type { IPAddress } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { DnsMessageHandler } from '@/network/dns/transport/DnsUdpTransport';
import { bindTlsByteService, unbindTlsByteService, sendTlsRequest } from '@/network/dns/transport/SimulatedTls';

export const DOT_PORT = 853;
export const DOT_ALPN = 'dot';

export interface DotOptions {
  readonly port?: number;
  readonly alpn?: string;
  readonly sni?: string;
  readonly timeoutMs?: number;
}

export function bindDnsTlsServer(host: EndHost, handler: DnsMessageHandler, options: DotOptions = {}): void {
  bindTlsByteService(host, options.port ?? DOT_PORT, options.alpn ?? DOT_ALPN, (requestBytes) => {
    let query: DnsMessage;
    try {
      query = decodeDnsMessage(requestBytes);
    } catch {
      return null;
    }
    return encodeDnsMessage(handler(query));
  });
}

export function unbindDnsTlsServer(host: EndHost, port: number = DOT_PORT): void {
  unbindTlsByteService(host, port);
}

export async function queryDnsOverTls(
  host: EndHost,
  serverIP: IPAddress,
  query: DnsMessage,
  options: DotOptions = {},
): Promise<DnsMessage | null> {
  const responseBytes = await sendTlsRequest(
    host,
    serverIP.toString(),
    options.port ?? DOT_PORT,
    options.alpn ?? DOT_ALPN,
    encodeDnsMessage(query),
    { sni: options.sni, timeoutMs: options.timeoutMs },
  );
  if (!responseBytes) return null;
  try {
    const response = decodeDnsMessage(responseBytes);
    return response.id === query.id ? response : null;
  } catch {
    return null;
  }
}
