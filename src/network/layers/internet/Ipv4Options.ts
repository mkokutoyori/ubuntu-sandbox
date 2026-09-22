import {
  IPAddress, computeIPv4Checksum,
  IP_OPTION_RECORD_ROUTE, IP_OPTION_LOOSE_SOURCE_ROUTE, IP_OPTION_STRICT_SOURCE_ROUTE,
  type IPv4Option, type IPv4Packet,
} from '../../core/types';

const SMALLEST_LEGAL_POINTER = 4;
const ADDRESS_OCTETS = 4;

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
