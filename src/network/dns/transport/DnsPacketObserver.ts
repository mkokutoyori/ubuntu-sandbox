import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

export type DnsPacketDirection = 'send' | 'receive' | 'timeout';

export type DnsPacketTransport = 'udp' | 'tcp';

export interface DnsPacketEvent {
  readonly direction: DnsPacketDirection;
  readonly transport: DnsPacketTransport;
  readonly remote: string;
  readonly message: DnsMessage;
  readonly exchange: object;
}

export type DnsPacketObserver = (event: DnsPacketEvent) => void;

export function observedExchange<T extends DnsMessage | null>(
  observer: DnsPacketObserver | undefined, transport: DnsPacketTransport, remote: string, query: DnsMessage,
  ask: () => Promise<T>,
): Promise<T> {
  if (observer === undefined) return ask();
  const exchange = {};
  observer({ direction: 'send', transport, remote, message: query, exchange });
  return ask().then((response) => {
    if (response !== null) observer({ direction: 'receive', transport, remote, message: response, exchange });
    else observer({ direction: 'timeout', transport, remote, message: query, exchange });
    return response;
  });
}
