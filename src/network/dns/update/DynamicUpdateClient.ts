import type { IPAddress, IPv6Address } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import { buildUpdateMessage, type DnsUpdateRequest } from '@/network/dns/update/DnsUpdate';
import { signDnsMessage, type TsigKey } from '@/network/dns/tsig/Tsig';
import { encodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';

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
  key?: TsigKey,
): Promise<DynamicUpdateOutcome> {
  const id = nextId;
  nextId = (nextId + 1) % ID_SPACE;

  const encode = key
    ? (message: Parameters<typeof encodeDnsMessage>[0]) =>
        signDnsMessage(message, { key, timeSigned: Math.floor(Date.now() / 1000) })
    : encodeDnsMessage;

  const response = await queryDnsOverUdp(
    host, serverIP, buildUpdateMessage(request, id), undefined, timeoutMs, encode);
  if (!response) return { answered: false, rcode: DnsRcode.SERVFAIL };
  return { answered: true, rcode: response.flags.rcode };
}
