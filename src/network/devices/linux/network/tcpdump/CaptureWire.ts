import { onesComplement, pushBytesAsWords, pushPseudoHeader } from '@/network/layers/transport/L4Checksum';
import type { TcpOption } from '@/network/tcp/types';

const TCP_HEADER_BYTES = 20;
const KIND = { end: 0, nop: 1, mss: 2, windowScale: 3, sackPermitted: 4, sack: 5, timestamp: 8 } as const;
const IP_PROTO_ICMP = 1;
const IP_PROTO_TCP = 6;
const IP_PROTO_UDP = 17;
const IP_PROTO_ICMPV6 = 58;

export function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

export function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

export function internetChecksum(bytes: readonly number[]): number {
  const words: number[] = [];
  pushBytesAsWords(words, bytes as number[]);
  return onesComplement(words);
}

export function transportChecksum(
  sourceIp: string, destinationIp: string, protocol: number, segment: readonly number[],
): number {
  const words: number[] = [];
  pushPseudoHeader(words, sourceIp, destinationIp, protocol, segment.length);
  pushBytesAsWords(words, segment as number[]);
  return onesComplement(words);
}

const LINUX_OPTION_ORDER: Readonly<Record<TcpOption['kind'], number>> = {
  mss: 0, 'sack-permitted': 1, timestamp: 2, 'window-scale': 3, sack: 4, nop: 5, end: 6,
};

function linuxOrdered(options: readonly TcpOption[]): readonly TcpOption[] {
  if (options.some(option => option.kind === 'nop' || option.kind === 'end')) return options;
  return [...options].sort((a, b) => LINUX_OPTION_ORDER[a.kind] - LINUX_OPTION_ORDER[b.kind]);
}

export function encodeTcpOptions(declared: readonly TcpOption[]): number[] {
  const bytes: number[] = [];
  let previous: TcpOption['kind'] | null = null;
  for (const option of linuxOrdered(declared)) {
    switch (option.kind) {
      case 'mss': bytes.push(KIND.mss, 4, ...u16(option.value)); break;
      case 'sack-permitted': bytes.push(KIND.sackPermitted, 2); break;
      case 'window-scale': bytes.push(KIND.nop, KIND.windowScale, 3, option.shift & 0xff); break;
      case 'timestamp':
        if (previous !== 'sack-permitted') bytes.push(KIND.nop, KIND.nop);
        bytes.push(KIND.timestamp, 10, ...u32(option.tsVal >>> 0), ...u32(option.tsEcr >>> 0));
        break;
      case 'sack':
        bytes.push(KIND.nop, KIND.nop, KIND.sack, 2 + option.blocks.length * 8);
        for (const block of option.blocks) bytes.push(...u32(block.start >>> 0), ...u32(block.end >>> 0));
        break;
      case 'nop': bytes.push(KIND.nop); break;
      case 'end': bytes.push(KIND.end); break;
    }
    previous = option.kind;
  }
  while (bytes.length % 4 !== 0) bytes.push(KIND.end);
  return bytes;
}

export interface TcpWireInput {
  readonly sourcePort: number;
  readonly destinationPort: number;
  readonly sequence: number;
  readonly acknowledgement: number;
  readonly dataOffset: number;
  readonly flagBits: number;
  readonly window: number;
  readonly urgentPointer: number;
  readonly options: readonly TcpOption[];
  readonly payload: readonly number[];
}

export function tcpWireBytes(
  input: TcpWireInput, sourceIp: string, destinationIp: string, corruptChecksum: boolean,
): number[] {
  const options = encodeTcpOptions(input.options);
  while (options.length < (input.dataOffset - 5) * 4) options.push(KIND.end);
  const headerWords = 5 + options.length / 4;
  const build = (checksum: number): number[] => [
    ...u16(input.sourcePort), ...u16(input.destinationPort),
    ...u32(input.sequence >>> 0), ...u32(input.acknowledgement >>> 0),
    headerWords << 4, input.flagBits,
    ...u16(input.window & 0xffff), ...u16(checksum), ...u16(input.urgentPointer & 0xffff),
    ...options, ...input.payload,
  ];
  const real = transportChecksum(sourceIp, destinationIp, IP_PROTO_TCP, build(0));
  return build(corruptChecksum ? (real - 1) & 0xffff : real);
}

export function udpWireBytes(
  sourcePort: number, destinationPort: number, length: number, payload: readonly number[],
  sourceIp: string, destinationIp: string, checksumPresent: boolean, corruptChecksum: boolean,
  protocol: number = IP_PROTO_UDP,
): number[] {
  const build = (checksum: number): number[] => [
    ...u16(sourcePort), ...u16(destinationPort), ...u16(length), ...u16(checksum), ...payload,
  ];
  if (!checksumPresent) return build(0);
  const real = transportChecksum(sourceIp, destinationIp, protocol, build(0));
  const value = real === 0 ? 0xffff : real;
  return build(corruptChecksum ? (value - 1) & 0xffff || 0xffff : value);
}

export interface IcmpWireInput {
  readonly type: number;
  readonly code: number;
  readonly id: number;
  readonly sequence: number;
  readonly mtu?: number;
  readonly pointer?: number;
  readonly gateway?: readonly number[];
  readonly timestamps?: { readonly originate: number; readonly receive: number; readonly transmit: number };
  readonly quoted?: readonly number[];
  readonly dataSize: number;
}

const QUOTING_TYPES = new Set([3, 4, 5, 11, 12]);

export function icmpWireBytes(input: IcmpWireInput): number[] {
  let rest: number[];
  if (input.type === 3 || input.type === 4 || input.type === 11) {
    rest = [0, 0, ...u16(input.type === 3 && input.code === 4 ? (input.mtu ?? 0) & 0xffff : 0)];
  } else if (input.type === 12) {
    rest = [(input.pointer ?? 0) & 0xff, 0, 0, 0];
  } else if (input.type === 5) {
    rest = [...(input.gateway ?? [0, 0, 0, 0])];
  } else {
    rest = [...u16(input.id & 0xffff), ...u16(input.sequence & 0xffff)];
  }
  let body: number[];
  if (input.timestamps) {
    body = [...u32(input.timestamps.originate), ...u32(input.timestamps.receive), ...u32(input.timestamps.transmit)];
  } else if (QUOTING_TYPES.has(input.type) && input.quoted !== undefined) {
    body = [...input.quoted];
  } else {
    body = Array.from({ length: input.dataSize }, (_, i) => i & 0xff);
  }
  const message = [input.type, input.code & 0xff, 0, 0, ...rest, ...body];
  const checksum = internetChecksum(message);
  message[2] = checksum >> 8;
  message[3] = checksum & 0xff;
  return message;
}

export function icmpv6WireBytes(
  type: number, code: number, rest: readonly number[], sourceIp: string, destinationIp: string,
): number[] {
  const message = [type, code & 0xff, 0, 0, ...rest];
  const checksum = transportChecksum(sourceIp, destinationIp, IP_PROTO_ICMPV6, message);
  message[2] = checksum >> 8;
  message[3] = checksum & 0xff;
  return message;
}

export function ipv4HeaderChecksumStamped(header: number[]): number[] {
  header[10] = 0;
  header[11] = 0;
  const checksum = internetChecksum(header);
  header[10] = checksum >> 8;
  header[11] = checksum & 0xff;
  return header;
}

export const WIRE_PROTOCOLS = { icmp: IP_PROTO_ICMP, tcp: IP_PROTO_TCP, udp: IP_PROTO_UDP, icmpv6: IP_PROTO_ICMPV6 } as const;
