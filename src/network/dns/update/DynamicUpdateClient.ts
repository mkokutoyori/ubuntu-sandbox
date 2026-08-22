import type { IPAddress, IPv6Address } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import { buildUpdateMessage, type DnsUpdateRequest } from '@/network/dns/update/DnsUpdate';

const ID_SPACE = 0x10000;
let nextId = 1;

export interface DynamicUpdateOutcome {
  readonly answered: boolean;
  readonly rcode: number;
}

export async function sendDynamicUpdate(
  host: EndHost,
  serverIP: IPAddress | IPv6Address,
  request: DnsUpdateRequest,
  timeoutMs = 2000,
): Promise<DynamicUpdateOutcome> {
  const id = nextId;
  nextId = (nextId + 1) % ID_SPACE;

  const response = await queryDnsOverUdp(
    host, serverIP, buildUpdateMessage(request, id), undefined, timeoutMs);
  if (!response) return { answered: false, rcode: DnsRcode.SERVFAIL };
  return { answered: true, rcode: response.flags.rcode };
}
