import type { IPAddress } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { queryDnsOverUdp, DNS_PORT } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ResourceRecord, ResourceRecordData, SoaRecordData } from '@/network/dns/wire/ResourceRecord';

const NOTIFY_TIMEOUT_MS = 1000;
const ID_SPACE = 0x10000;

let nextNotifyId = 1;

function allocateId(): number {
  const id = nextNotifyId;
  nextNotifyId = (nextNotifyId + 1) % ID_SPACE;
  return id;
}

export function makeNotify(origin: string, soa: ResourceRecord<SoaRecordData>): DnsMessage {
  return {
    id: allocateId(),
    flags: {
      qr: false, opcode: DnsOpcode.NOTIFY, aa: true, tc: false,
      rd: false, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
    },
    questions: [{ qname: origin, qtype: RRType.SOA, qclass: DnsClass.IN }],
    answers: [soa as ResourceRecord<ResourceRecordData>],
    authorities: [],
    additionals: [],
  };
}

export function isNotify(message: DnsMessage): boolean {
  return !message.flags.qr && message.flags.opcode === DnsOpcode.NOTIFY;
}

export function makeNotifyAck(notify: DnsMessage): DnsMessage {
  return {
    id: notify.id,
    flags: {
      qr: true, opcode: DnsOpcode.NOTIFY, aa: false, tc: false,
      rd: false, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
    },
    questions: notify.questions,
    answers: [],
    authorities: [],
    additionals: [],
  };
}

export async function sendNotify(
  host: EndHost,
  secondaryIP: IPAddress,
  origin: string,
  soa: ResourceRecord<SoaRecordData>,
  timeoutMs: number = NOTIFY_TIMEOUT_MS,
): Promise<boolean> {
  const ack = await queryDnsOverUdp(host, secondaryIP, makeNotify(origin, soa), DNS_PORT, timeoutMs);
  return ack !== null;
}
