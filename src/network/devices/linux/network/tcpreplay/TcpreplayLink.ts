import { linkTypeDescriptionOf } from '@/network/capture/pcap/PcapFile';
import { fatalText } from './TcpreplayDiagnostics';

export const DLT_NULL = 0;
export const DLT_EN10MB = 1;
export const DLT_PPP_SERIAL = 50;
export const DLT_RAW = 12;
export const DLT_C_HDLC = 104;
export const DLT_LINUX_SLL = 113;
export const DLT_JUNIPER_ETHER = 178;

const LINKTYPE_RAW = 101;
const ETHERTYPE_IP = 0x0800;
const ETHERTYPE_IP6 = 0x86dd;
const ETHERTYPE_VLAN = 0x8100;
const ETHERTYPE_Q_IN_Q = 0x88a8;
const ETHERTYPE_8021QINQ = 0x9100;
const ETHERTYPE_MPLS = 0x8847;
const ETHERTYPE_MPLS_MULTI = 0x8848;
const ETHERNET_HEADER_BYTES = 14;
const VLAN_HEADER_BYTES = 4;
const MPLS_LABEL_BYTES = 4;
const MPLS_BOTTOM_OF_STACK = 0x100;
const MPLS_LABEL_SHIFT = 12;
const MPLS_LABEL_GACH = 13;
const SLL_HEADER_BYTES = 16;
const PPP_SERIAL_HEADER_BYTES = 4;
const CISCO_HDLC_BYTES = 4;
const JUNIPER_MAGIC = [0x4d, 0x47, 0x43];
const JUNIPER_FLAG_NO_L2 = 0x02;
const JUNIPER_FLAG_EXT = 0x80;

export class ReplayFatal extends Error {
  constructor(readonly text: string) {
    super(text);
  }
}

export interface LinkLayout {
  readonly protocol: number;
  readonly l2len: number;
  readonly l2offset: number;
}

export function datalinkOfLinkType(linkType: number): number {
  return linkType === LINKTYPE_RAW ? DLT_RAW : linkType;
}

export function linkTypeOfDatalink(datalink: number): number {
  return datalink === DLT_RAW ? LINKTYPE_RAW : datalink;
}

export function datalinkDescription(datalink: number): string {
  return linkTypeDescriptionOf(linkTypeOfDatalink(datalink)) ?? 'Unknown';
}

function u16(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

interface MetadataState {
  nextProtocol: number;
  l2len: number;
  l2offset: number;
}

function parseVlan(bytes: Uint8Array, state: MetadataState): boolean {
  if (bytes.length < state.l2len + VLAN_HEADER_BYTES) return false;
  state.nextProtocol = u16(bytes, state.l2len + 2);
  state.l2len += VLAN_HEADER_BYTES;
  return true;
}

function parseMpls(bytes: Uint8Array, state: MetadataState): boolean {
  let length = state.l2len;
  let bottom = false;
  while (!bottom) {
    if (length + MPLS_LABEL_BYTES > bytes.length) return false;
    const entry = u32(bytes, length);
    length += MPLS_LABEL_BYTES;
    bottom = (entry & MPLS_BOTTOM_OF_STACK) !== 0;
    if (entry >>> MPLS_LABEL_SHIFT === MPLS_LABEL_GACH) return false;
  }
  if (length + 1 > bytes.length) return false;
  const firstNibble = bytes[length] >> 4;
  if (firstNibble === 4) state.nextProtocol = ETHERTYPE_IP;
  else if (firstNibble === 6) state.nextProtocol = ETHERTYPE_IP6;
  else if (firstNibble === 0) {
    if (length + 4 + ETHERNET_HEADER_BYTES > bytes.length) return false;
    length += 4;
    state.l2offset = length;
    state.nextProtocol = u16(bytes, length + 12);
    length += ETHERNET_HEADER_BYTES;
  } else return false;
  state.l2len = length;
  return true;
}

function parseMetadata(bytes: Uint8Array, state: MetadataState): boolean {
  for (;;) {
    switch (state.nextProtocol) {
      case ETHERTYPE_VLAN:
      case ETHERTYPE_Q_IN_Q:
      case ETHERTYPE_8021QINQ:
        if (!parseVlan(bytes, state)) return false;
        break;
      case ETHERTYPE_MPLS:
      case ETHERTYPE_MPLS_MULTI:
        if (!parseMpls(bytes, state)) return false;
        break;
      default:
        return true;
    }
  }
}

function ipVersionProtocol(nibble: number): number {
  if (nibble === 4) return ETHERTYPE_IP;
  if (nibble === 6) return ETHERTYPE_IP6;
  return 0;
}

function ethernetLayout(bytes: Uint8Array, l2offset: number): LinkLayout | null {
  const netOffset = ETHERNET_HEADER_BYTES + l2offset;
  if (bytes.length <= netOffset) return null;
  const state: MetadataState = { nextProtocol: u16(bytes, l2offset + 12), l2len: netOffset, l2offset };
  if (!parseMetadata(bytes, state)) return null;
  if (bytes.length <= state.l2len) return null;
  if (state.nextProtocol > 1500) return { protocol: state.nextProtocol, l2len: state.l2len, l2offset: state.l2offset };
  const protocol = ipVersionProtocol(bytes[state.l2len] >> 4);
  if (protocol === 0) return null;
  return { protocol, l2len: state.l2len, l2offset: state.l2offset };
}

export function linkLayoutOf(bytes: Uint8Array, datalink: number): LinkLayout | null {
  switch (datalink) {
    case DLT_NULL:
    case DLT_RAW:
      return { protocol: ipVersionProtocol(bytes[0] >> 4), l2len: 0, l2offset: 0 };
    case DLT_JUNIPER_ETHER: {
      if (bytes.length < 4) return null;
      if (!JUNIPER_MAGIC.every((value, index) => bytes[index] === value)) return null;
      let l2offset: number;
      if ((bytes[3] & JUNIPER_FLAG_EXT) === JUNIPER_FLAG_EXT) {
        if (bytes.length < 6) return null;
        l2offset = u16(bytes, 4) + 6;
      } else l2offset = 4;
      if ((bytes[3] & JUNIPER_FLAG_NO_L2) === JUNIPER_FLAG_NO_L2) {
        if (bytes.length < l2offset + 1) return null;
        return { protocol: ipVersionProtocol(bytes[l2offset] >> 4), l2len: 0, l2offset };
      }
      return ethernetLayout(bytes, l2offset);
    }
    case DLT_EN10MB:
      return ethernetLayout(bytes, 0);
    case DLT_PPP_SERIAL: {
      if (bytes.length < PPP_SERIAL_HEADER_BYTES) return null;
      const protocol = u16(bytes, 2);
      return { protocol: protocol === 0x0021 ? ETHERTYPE_IP : protocol, l2len: PPP_SERIAL_HEADER_BYTES, l2offset: 0 };
    }
    case DLT_C_HDLC:
      if (bytes.length < CISCO_HDLC_BYTES) return null;
      return { protocol: u16(bytes, 2), l2len: CISCO_HDLC_BYTES, l2offset: 0 };
    case DLT_LINUX_SLL:
      if (bytes.length < SLL_HEADER_BYTES) return null;
      return { protocol: u16(bytes, 14), l2len: SLL_HEADER_BYTES, l2offset: 0 };
    default:
      throw new ReplayFatal(fatalText('get.c', 'get_l2len_protocol', 366,
        `Unable to process unsupported DLT type: ${datalinkDescription(datalink)} (0x${datalink.toString(16)})`));
  }
}

export const ETHERTYPES = { ip: ETHERTYPE_IP, ip6: ETHERTYPE_IP6 } as const;
