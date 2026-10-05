import { TCP_BASE_HEADER_BYTES } from './types';

export type SegmentFamily = 'ipv4' | 'ipv6';

export const DEFAULT_ETHERNET_MTU = 1500;
export const LOOPBACK_MTU = 65536;

const IP_HEADER_BYTES: Readonly<Record<SegmentFamily, number>> = { ipv4: 20, ipv6: 40 };
const DEFAULT_SEND_MSS: Readonly<Record<SegmentFamily, number>> = { ipv4: 536, ipv6: 1220 };

export function ipHeaderBytes(family: SegmentFamily): number {
  return IP_HEADER_BYTES[family];
}

export function defaultSendMss(family: SegmentFamily): number {
  return DEFAULT_SEND_MSS[family];
}

export function mssForMtu(family: SegmentFamily, mtu: number): number {
  return mtu - IP_HEADER_BYTES[family] - TCP_BASE_HEADER_BYTES;
}
