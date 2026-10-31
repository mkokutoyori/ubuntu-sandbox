import {
  IPAddress, computeIPv4Checksum,
  IP_OPTION_RECORD_ROUTE, IP_OPTION_LOOSE_SOURCE_ROUTE, IP_OPTION_STRICT_SOURCE_ROUTE, IP_OPTION_TIMESTAMP,
  type IPv4Option, type IPv4Packet,
} from '../../core/types';

const SMALLEST_LEGAL_POINTER = 4;
const ADDRESS_OCTETS = 4;
const SMALLEST_TIMESTAMP_POINTER = 5;
const MAXIMUM_OVERFLOW = 15;

export const TIMESTAMP_FLAG_ONLY = 0;
export const TIMESTAMP_FLAG_WITH_ADDRESS = 1;
export const TIMESTAMP_FLAG_PRESPECIFIED = 3;

function isSourceRouteOption(type: number): boolean {
  return type === IP_OPTION_LOOSE_SOURCE_ROUTE || type === IP_OPTION_STRICT_SOURCE_ROUTE;
}

function findOption(pkt: IPv4Packet, matches: (type: number) => boolean): IPv4Option | null {
  return pkt.options?.find(option => matches(option.type)) ?? null;
}

function sourceRouteOption(pkt: IPv4Packet): IPv4Option | null {
  return findOption(pkt, isSourceRouteOption);
}

function optionLength(option: IPv4Option): number {
  return option.data.length + 2;
}

function addressAt(option: IPv4Option, pointer: number): IPAddress {
  const start = pointer - 3;
  return new IPAddress([
    option.data[start], option.data[start + 1], option.data[start + 2], option.data[start + 3],
  ]);
}

export type SourceRouteState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'exhausted' }
  | { readonly kind: 'malformed' }
  | {
    readonly kind: 'pending';
    readonly nextHop: IPAddress;
    readonly strict: boolean;
    readonly pointer: number;
  };

export function sourceRouteState(
  pkt: IPv4Packet, isOwnAddress: (address: IPAddress) => boolean,
): SourceRouteState {
  const option = sourceRouteOption(pkt);
  if (!option) return { kind: 'absent' };

  const length = optionLength(option);
  let pointer = option.data[0];
  if (pointer === undefined || pointer < SMALLEST_LEGAL_POINTER) return { kind: 'malformed' };

  while (pointer <= length) {
    if (pointer + ADDRESS_OCTETS - 1 > length) return { kind: 'malformed' };
    const candidate = addressAt(option, pointer);
    if (!isOwnAddress(candidate)) {
      return {
        kind: 'pending', nextHop: candidate, pointer,
        strict: option.type === IP_OPTION_STRICT_SOURCE_ROUTE,
      };
    }
    pointer += ADDRESS_OCTETS;
  }
  return { kind: 'exhausted' };
}

function withOption(pkt: IPv4Packet, replaced: IPv4Option, updated: IPv4Option): IPv4Option[] {
  return (pkt.options ?? []).map(option => (option === replaced ? updated : option));
}

function resealed(pkt: IPv4Packet, next: IPv4Packet): IPv4Packet {
  const sealed: IPv4Packet = { ...next, headerChecksum: 0 };
  sealed.headerChecksum = computeIPv4Checksum(sealed);
  return sealed;
}

export function advanceSourceRoute(
  pkt: IPv4Packet, state: Extract<SourceRouteState, { kind: 'pending' }>, recorded: IPAddress,
): IPv4Packet {
  const option = sourceRouteOption(pkt);
  if (!option) return pkt;
  const data = [...option.data];
  const start = state.pointer - 3;
  const octets = recorded.getOctets();
  for (let i = 0; i < ADDRESS_OCTETS; i++) data[start + i] = octets[i];
  data[0] = state.pointer + ADDRESS_OCTETS;
  return resealed(pkt, {
    ...pkt,
    destinationIP: state.nextHop,
    options: withOption(pkt, option, { type: option.type, data }),
  });
}

export type RecordRouteOutcome =
  | { readonly kind: 'unchanged'; readonly packet: IPv4Packet }
  | { readonly kind: 'recorded'; readonly packet: IPv4Packet }
  | { readonly kind: 'error' };

export function recordRoute(pkt: IPv4Packet, recorded: IPAddress): RecordRouteOutcome {
  const option = findOption(pkt, type => type === IP_OPTION_RECORD_ROUTE);
  if (!option) return { kind: 'unchanged', packet: pkt };

  const length = optionLength(option);
  const pointer = option.data[0];
  if (pointer === undefined || pointer < SMALLEST_LEGAL_POINTER) return { kind: 'error' };
  if (pointer > length) return { kind: 'unchanged', packet: pkt };
  if (pointer + ADDRESS_OCTETS - 1 > length) return { kind: 'error' };

  const data = [...option.data];
  const start = pointer - 3;
  const octets = recorded.getOctets();
  for (let i = 0; i < ADDRESS_OCTETS; i++) data[start + i] = octets[i];
  data[0] = pointer + ADDRESS_OCTETS;
  return {
    kind: 'recorded',
    packet: resealed(pkt, { ...pkt, options: withOption(pkt, option, { type: option.type, data }) }),
  };
}

export function routeAddressesOf(option: IPv4Option): IPAddress[] {
  const addresses: IPAddress[] = [];
  const pointer = option.data[0] ?? SMALLEST_LEGAL_POINTER;
  for (let p = SMALLEST_LEGAL_POINTER; p < pointer; p += ADDRESS_OCTETS) {
    if (p + ADDRESS_OCTETS - 1 > optionLength(option)) break;
    addresses.push(addressAt(option, p));
  }
  return addresses;
}

export function buildRecordRouteOption(slots: number): IPv4Option {
  return { type: IP_OPTION_RECORD_ROUTE, data: [SMALLEST_LEGAL_POINTER, ...new Array(slots * ADDRESS_OCTETS).fill(0)] };
}

export function buildSourceRouteOption(hops: readonly IPAddress[], strict: boolean): IPv4Option {
  const data: number[] = [SMALLEST_LEGAL_POINTER];
  for (const hop of hops) data.push(...hop.getOctets());
  return {
    type: strict ? IP_OPTION_STRICT_SOURCE_ROUTE : IP_OPTION_LOOSE_SOURCE_ROUTE,
    data,
  };
}

export function reflectRecordRoute(pkt: IPv4Packet, recorded: IPAddress): IPv4Option | null {
  const option = findOption(pkt, type => type === IP_OPTION_RECORD_ROUTE);
  if (!option) return null;
  const carried: IPv4Packet = { ...pkt, options: [option] };
  const outcome = recordRoute(carried, recorded);
  if (outcome.kind === 'error') return option;
  return outcome.packet.options?.[0] ?? option;
}

export interface ReversedSourceRoute {
  readonly firstHop: IPAddress;
  readonly option: IPv4Option;
}

export function reverseSourceRoute(
  pkt: IPv4Packet, ultimateDestination: IPAddress,
): ReversedSourceRoute | null {
  const option = sourceRouteOption(pkt);
  if (!option) return null;
  const travelled = routeAddressesOf(option);
  if (travelled.length === 0) return null;

  const reversed = [...travelled].reverse();
  const firstHop = reversed[0];
  const remaining = [...reversed.slice(1), ultimateDestination];
  const data: number[] = [SMALLEST_LEGAL_POINTER];
  for (const hop of remaining) data.push(...hop.getOctets());
  return { firstHop, option: { type: option.type, data } };
}

export interface TimestampStamp {
  readonly address: IPAddress;
  readonly msOfDay: number;
  owns(address: IPAddress): boolean;
}

function writeWord(data: number[], at: number, value: number): void {
  data[at] = (value >>> 24) & 0xff;
  data[at + 1] = (value >>> 16) & 0xff;
  data[at + 2] = (value >>> 8) & 0xff;
  data[at + 3] = value & 0xff;
}

export function recordTimestamp(pkt: IPv4Packet, stamp: TimestampStamp): RecordRouteOutcome {
  const option = findOption(pkt, type => type === IP_OPTION_TIMESTAMP);
  if (!option) return { kind: 'unchanged', packet: pkt };

  const length = optionLength(option);
  const pointer = option.data[0];
  const flagByte = option.data[1];
  if (length < 4 || pointer === undefined || flagByte === undefined || pointer < SMALLEST_TIMESTAMP_POINTER) {
    return { kind: 'error' };
  }
  const flag = flagByte & 0x0f;
  const data = [...option.data];
  const start = pointer - 3;

  if (pointer <= length) {
    if (pointer + 3 > length) return { kind: 'error' };
    if (flag === TIMESTAMP_FLAG_ONLY) {
      writeWord(data, start, stamp.msOfDay);
      data[0] = pointer + 4;
    } else if (flag === TIMESTAMP_FLAG_WITH_ADDRESS) {
      if (pointer + 7 > length) return { kind: 'error' };
      data.splice(start, ADDRESS_OCTETS, ...stamp.address.getOctets());
      writeWord(data, start + ADDRESS_OCTETS, stamp.msOfDay);
      data[0] = pointer + 8;
    } else if (flag === TIMESTAMP_FLAG_PRESPECIFIED) {
      if (pointer + 7 > length) return { kind: 'error' };
      const named = new IPAddress([data[start], data[start + 1], data[start + 2], data[start + 3]]);
      if (!stamp.owns(named)) return { kind: 'unchanged', packet: pkt };
      writeWord(data, start + ADDRESS_OCTETS, stamp.msOfDay);
      data[0] = pointer + 8;
    } else {
      return { kind: 'unchanged', packet: pkt };
    }
  } else if (flag !== TIMESTAMP_FLAG_PRESPECIFIED) {
    const overflow = flagByte >> 4;
    if (overflow === MAXIMUM_OVERFLOW) return { kind: 'error' };
    data[1] = flag | ((overflow + 1) << 4);
  } else {
    return { kind: 'unchanged', packet: pkt };
  }
  return {
    kind: 'recorded',
    packet: resealed(pkt, { ...pkt, options: withOption(pkt, option, { type: option.type, data }) }),
  };
}

export function buildTimestampOption(
  flag: number, slots: number, prespecified: readonly IPAddress[] = [],
): IPv4Option {
  if (flag === TIMESTAMP_FLAG_PRESPECIFIED) {
    const data: number[] = [SMALLEST_TIMESTAMP_POINTER, flag];
    for (const named of prespecified) data.push(...named.getOctets(), 0, 0, 0, 0);
    return { type: IP_OPTION_TIMESTAMP, data };
  }
  const width = flag === TIMESTAMP_FLAG_ONLY ? 4 : 8;
  return { type: IP_OPTION_TIMESTAMP, data: [SMALLEST_TIMESTAMP_POINTER, flag, ...new Array(slots * width).fill(0)] };
}

export interface TimestampEntry {
  readonly address: IPAddress | null;
  readonly msOfDay: number;
  readonly nonStandard: boolean;
}

export interface TimestampReading {
  readonly flag: number;
  readonly overflow: number;
  readonly entries: readonly TimestampEntry[];
}

export function readTimestamp(option: IPv4Option): TimestampReading {
  const pointer = option.data[0] ?? SMALLEST_TIMESTAMP_POINTER;
  const flagByte = option.data[1] ?? 0;
  const flag = flagByte & 0x0f;
  const width = flag === TIMESTAMP_FLAG_ONLY ? 4 : 8;
  const entries: TimestampEntry[] = [];
  for (let p = SMALLEST_TIMESTAMP_POINTER; p + width - 1 < pointer; p += width) {
    const at = p - 3;
    const timeAt = flag === TIMESTAMP_FLAG_ONLY ? at : at + ADDRESS_OCTETS;
    const raw = ((option.data[timeAt] << 24) | (option.data[timeAt + 1] << 16)
      | (option.data[timeAt + 2] << 8) | option.data[timeAt + 3]) >>> 0;
    entries.push({
      address: flag === TIMESTAMP_FLAG_ONLY ? null : addressAt(option, p),
      msOfDay: raw & 0x7fffffff,
      nonStandard: (raw & 0x80000000) !== 0,
    });
  }
  return { flag, overflow: flagByte >> 4, entries };
}

export function reflectTimestamp(pkt: IPv4Packet, stamp: TimestampStamp): IPv4Option | null {
  const option = findOption(pkt, type => type === IP_OPTION_TIMESTAMP);
  if (!option) return null;
  const carried: IPv4Packet = { ...pkt, options: [option] };
  const outcome = recordTimestamp(carried, stamp);
  if (outcome.kind === 'error') return option;
  return outcome.packet.options?.[0] ?? option;
}

export function stampAtHost(pkt: IPv4Packet, address: IPAddress, msOfDay: number): IPv4Packet {
  const recorded = recordRoute(pkt, address);
  const afterRoute = recorded.kind === 'recorded' ? recorded.packet : pkt;
  const stamped = recordTimestamp(afterRoute, { address, msOfDay, owns: named => named.equals(address) });
  return stamped.kind === 'recorded' ? stamped.packet : afterRoute;
}
