import { internetChecksum } from '@/network/layers/transport/L4Checksum';
import type { PimBootstrapBody, PimCandidateRpBody, PimHelloOption, PimJoinPruneBody, PimMessageType, PimPacket } from './types';

const VERSION_SHIFT = 4;
const HEADER_BYTES = 4;
const CHECKSUM_OFFSET = 2;
const FAMILY_IPV4 = 1;
const ENCODING_NATIVE = 0;
const HOST_MASK_BITS = 32;
const SOURCE_FLAG_SPARSE = 0x04;
const SOURCE_FLAGS_RP_TREE = 0x07;
const OVERRIDE_INTERVAL_MS = 2500;
const REFRESH_CAPABILITY_VERSION = 1;

const MESSAGE_TYPES: Readonly<Record<PimMessageType, number>> = { hello: 0, 'join-prune': 3, bootstrap: 4, 'candidate-rp-advertisement': 8 };
const OPTION_CODES: Readonly<Record<PimHelloOption['type'], number>> = {
  holdtime: 1, 'lan-prune-delay': 2, 'dr-priority': 19, 'generation-id': 20, 'state-refresh': 21, 'address-list': 24,
};

function u16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function ipv4(text: string): number[] {
  const parts = text.split('.').map((part) => parseInt(part, 10) & 0xff);
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4);
}

function encodedUnicast(address: string): number[] {
  return [FAMILY_IPV4, ENCODING_NATIVE, ...ipv4(address)];
}

function encodedGroup(address: string, maskBits: number = HOST_MASK_BITS): number[] {
  return [FAMILY_IPV4, ENCODING_NATIVE, 0, maskBits, ...ipv4(address)];
}

function encodedSource(address: string, flags: number): number[] {
  return [FAMILY_IPV4, ENCODING_NATIVE, flags, HOST_MASK_BITS, ...ipv4(address)];
}

function option(code: number, value: readonly number[]): number[] {
  return [...u16(code), ...u16(value.length), ...value];
}

function helloOption(entry: PimHelloOption): number[] {
  const code = OPTION_CODES[entry.type];
  if (entry.type === 'address-list') return option(code, (entry.value as string[]).flatMap(encodedUnicast));
  const value = Number(entry.value);
  if (entry.type === 'holdtime') return option(code, u16(value));
  if (entry.type === 'lan-prune-delay') return option(code, [...u16(value & 0x7fff), ...u16(OVERRIDE_INTERVAL_MS)]);
  if (entry.type === 'state-refresh') return option(code, [REFRESH_CAPABILITY_VERSION, value & 0xff, 0, 0]);
  return option(code, u32(value));
}

function joinPrune(body: PimJoinPruneBody): number[] {
  const groups = body.groups.flatMap((group) => {
    const rpTree = group.rpAddress === undefined ? [] : [encodedSource(group.rpAddress, SOURCE_FLAGS_RP_TREE)];
    const joined = [...(group.joinStarG ? rpTree : []), ...group.joinedSources.map((source) => encodedSource(source, SOURCE_FLAG_SPARSE))];
    const pruned = [...(group.pruneStarG ? rpTree : []), ...group.prunedSources.map((source) => encodedSource(source, SOURCE_FLAG_SPARSE))];
    return [...encodedGroup(group.groupAddress), ...u16(joined.length), ...u16(pruned.length), ...joined.flat(), ...pruned.flat()];
  });
  return [...encodedUnicast(body.upstreamNeighborIp), 0, body.groups.length, ...u16(body.holdtimeSec), ...groups];
}

function bootstrap(body: PimBootstrapBody): number[] {
  const groups = body.groups.flatMap((group) => [
    ...encodedGroup(group.groupRangeAddress, group.groupRangeMaskBits), group.rps.length, group.rps.length, 0, 0,
    ...group.rps.flatMap((rp) => [...encodedUnicast(rp.rpAddress), ...u16(rp.holdtimeSec), rp.priority & 0xff, 0]),
  ]);
  return [...u16(body.fragmentTag), 0, body.bsrPriority & 0xff, ...encodedUnicast(body.bsrAddress), ...groups];
}

function candidateRp(body: PimCandidateRpBody): number[] {
  return [
    body.groups.length, body.priority & 0xff, ...u16(body.holdtimeSec), ...encodedUnicast(body.rpAddress),
    ...body.groups.flatMap((group) => encodedGroup(group.groupRangeAddress, group.groupRangeMaskBits)),
  ];
}

function body(packet: PimPacket): number[] {
  if (packet.messageType === 'hello') return packet.options.flatMap(helloOption);
  if (packet.messageType === 'join-prune') return packet.joinPrune === undefined ? [] : joinPrune(packet.joinPrune);
  if (packet.messageType === 'bootstrap') return packet.bootstrap === undefined ? [] : bootstrap(packet.bootstrap);
  return packet.candidateRp === undefined ? [] : candidateRp(packet.candidateRp);
}

export function pimPayloadBytes(packet: PimPacket): number[] {
  const bytes = [(packet.version << VERSION_SHIFT) | MESSAGE_TYPES[packet.messageType], 0, 0, 0, ...body(packet)];
  const checksum = internetChecksum(bytes);
  bytes[CHECKSUM_OFFSET] = checksum >>> 8;
  bytes[CHECKSUM_OFFSET + 1] = checksum & 0xff;
  return bytes;
}

export function pimWireLength(packet: PimPacket): number {
  return Math.max(HEADER_BYTES, pimPayloadBytes(packet).length);
}
