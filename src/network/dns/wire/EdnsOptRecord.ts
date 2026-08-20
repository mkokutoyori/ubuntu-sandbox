import { RRType } from '@/network/dns/wire/RRType';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { OptRecordData, ResourceRecord } from '@/network/dns/wire/ResourceRecord';

export const CLASSIC_UDP_PAYLOAD_SIZE = 512;
export const DEFAULT_EDNS_PAYLOAD_SIZE = 4096;
export const EDNS_VERSION = 0;
export const EDNS_BADVERS_EXTENDED_RCODE_HIGH = 1;

const MAX_UINT16 = 0xffff;
const DO_BIT = 0x8000;

export interface OptRecordOptions {
  readonly version?: number;
  readonly dnssecOk?: boolean;
  readonly extendedRcodeHigh?: number;
}

export function packOptTtl(data: OptRecordData): number {
  return (
    ((data.extendedRcodeHigh & 0xff) << 24) |
    ((data.version & 0xff) << 16) |
    (data.dnssecOk ? DO_BIT : 0)
  ) >>> 0;
}

export function unpackOptTtl(ttl: number): Pick<OptRecordData, 'extendedRcodeHigh' | 'version' | 'dnssecOk'> {
  return {
    extendedRcodeHigh: (ttl >>> 24) & 0xff,
    version: (ttl >>> 16) & 0xff,
    dnssecOk: (ttl & DO_BIT) !== 0,
  };
}

export function makeOptRecord(udpPayloadSize: number, options: OptRecordOptions = {}): ResourceRecord<OptRecordData> {
  const size = Math.min(Math.max(udpPayloadSize, CLASSIC_UDP_PAYLOAD_SIZE), MAX_UINT16);
  const data: OptRecordData = {
    type: RRType.OPT,
    udpPayloadSize: size,
    version: options.version ?? EDNS_VERSION,
    dnssecOk: options.dnssecOk ?? false,
    extendedRcodeHigh: options.extendedRcodeHigh ?? 0,
  };
  return { name: '', ttl: packOptTtl(data), rrClass: size, data };
}

export function findOpt(message: DnsMessage): ResourceRecord<OptRecordData> | null {
  const opt = message.additionals.find((rr) => rr.data.type === RRType.OPT);
  return (opt as ResourceRecord<OptRecordData>) ?? null;
}
