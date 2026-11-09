import { RRType } from '@/network/dns/wire/RRType';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { EdnsOption, OptRecordData, ResourceRecord } from '@/network/dns/wire/ResourceRecord';

export const CLASSIC_UDP_PAYLOAD_SIZE = 512;
export const DEFAULT_EDNS_PAYLOAD_SIZE = 4096;
export const EDNS_VERSION = 0;
export const EDNS_BADVERS_EXTENDED_RCODE_HIGH = 1;
export const EDNS_OPTION_TCP_KEEPALIVE = 11;

const MAX_UINT16 = 0xffff;
const DO_BIT = 0x8000;

export interface OptRecordOptions {
  readonly version?: number;
  readonly dnssecOk?: boolean;
  readonly extendedRcodeHigh?: number;
  readonly options?: readonly EdnsOption[];
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
    ...(options.options && options.options.length > 0 ? { options: options.options } : {}),
  };
  return { name: '', ttl: packOptTtl(data), rrClass: size, data };
}

export function findOpt(message: DnsMessage): ResourceRecord<OptRecordData> | null {
  const opt = message.additionals.find((rr) => rr.data.type === RRType.OPT);
  return (opt as ResourceRecord<OptRecordData>) ?? null;
}

export function findOpts(message: DnsMessage): ResourceRecord<OptRecordData>[] {
  return message.additionals.filter(
    (rr): rr is ResourceRecord<OptRecordData> => rr.data.type === RRType.OPT);
}

export function echoedOpt(query: DnsMessage, udpPayloadSize: number): ResourceRecord<OptRecordData>[] {
  const opt = findOpt(query);
  return opt === null ? [] : [makeOptRecord(udpPayloadSize, { dnssecOk: opt.data.dnssecOk })];
}

export function hasEdnsOption(message: DnsMessage, code: number): boolean {
  return findOpt(message)?.data.options?.some((option) => option.code === code) === true;
}

export function tcpKeepaliveOption(units?: number): EdnsOption {
  const data = units === undefined ? new Uint8Array(0) : Uint8Array.of((units >> 8) & 0xff, units & 0xff);
  return { code: EDNS_OPTION_TCP_KEEPALIVE, data };
}

export function tcpKeepaliveUnits(message: DnsMessage): number | null {
  const option = findOpt(message)?.data.options?.find((candidate) => candidate.code === EDNS_OPTION_TCP_KEEPALIVE);
  return option === undefined || option.data.length !== 2 ? null : (option.data[0] << 8) | option.data[1];
}

export function withEdnsOption(message: DnsMessage, option: EdnsOption): DnsMessage {
  const opt = findOpt(message);
  if (opt === null) return message;
  const replaced: ResourceRecord<OptRecordData> = {
    ...opt, data: { ...opt.data, options: [...(opt.data.options ?? []), option] },
  };
  return { ...message, additionals: message.additionals.map((record) => (record === opt ? replaced : record)) };
}
