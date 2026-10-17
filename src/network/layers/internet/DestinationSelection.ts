import { IPAddress, IPv6Address } from '../../core/types';
import { ipv6ToBigInt } from '../../core/Ipv6Arithmetic';

export type SelectableAddress = IPAddress | IPv6Address;

export interface PolicyEntry {
  readonly prefix: IPv6Address;
  readonly length: number;
  readonly precedence: number;
  readonly label: number;
}

export interface DestinationSelectionPort {
  sourceFor(destination: SelectableAddress): SelectableAddress | null;
}

const SCOPE_LINK_LOCAL = 2;
const SCOPE_SITE_LOCAL = 5;
const SCOPE_GLOBAL = 14;

const NO_ENTRY: PolicyEntry = {
  prefix: new IPv6Address('::'), length: 0, precedence: 0, label: -1,
};

const SITE_LOCAL_PREFIX = new IPv6Address('fec0::');

const policyEntry = (prefix: string, length: number, precedence: number, label: number): PolicyEntry =>
  ({ prefix: new IPv6Address(prefix), length, precedence, label });

export const DEFAULT_POLICY_TABLE: readonly PolicyEntry[] = [
  policyEntry('::1', 128, 50, 0),
  policyEntry('::', 0, 40, 1),
  policyEntry('::ffff:0:0', 96, 35, 4),
  policyEntry('2002::', 16, 30, 2),
  policyEntry('2001::', 32, 5, 5),
  policyEntry('fc00::', 7, 3, 13),
  policyEntry('::', 96, 1, 3),
  policyEntry('fec0::', 10, 1, 11),
  policyEntry('3ffe::', 16, 1, 12),
];

export function ipv4MappedAddress(address: IPAddress): IPv6Address {
  const [a, b, c, d] = address.getOctets();
  return new IPv6Address([0, 0, 0, 0, 0, 0xffff, (a << 8) | b, (c << 8) | d]);
}

const asIpv6 = (address: SelectableAddress): IPv6Address =>
  address instanceof IPAddress ? ipv4MappedAddress(address) : address;

export function addressScope(address: SelectableAddress): number {
  if (address instanceof IPAddress) {
    const [first, second] = address.getOctets();
    return first === 127 || (first === 169 && second === 254) ? SCOPE_LINK_LOCAL : SCOPE_GLOBAL;
  }
  if (address.isLoopback() || address.isLinkLocal()) return SCOPE_LINK_LOCAL;
  return address.isInSameSubnet(SITE_LOCAL_PREFIX, 10) ? SCOPE_SITE_LOCAL : SCOPE_GLOBAL;
}

export function policyOf(address: SelectableAddress, table: readonly PolicyEntry[] = DEFAULT_POLICY_TABLE): PolicyEntry {
  const probe = asIpv6(address);
  let best = NO_ENTRY;
  let found = false;
  for (const entry of table) {
    if (!probe.isInSameSubnet(entry.prefix, entry.length)) continue;
    if (!found || entry.length > best.length) {
      best = entry;
      found = true;
    }
  }
  return best;
}

export function commonPrefixLength(left: SelectableAddress, right: SelectableAddress): number {
  const difference = ipv6ToBigInt(asIpv6(left)) ^ ipv6ToBigInt(asIpv6(right));
  return difference === 0n ? 128 : 128 - difference.toString(2).length;
}

interface Usable<T> {
  readonly usable: true;
  readonly item: T;
  readonly address: SelectableAddress;
  readonly scope: number;
  readonly sourceScope: number;
  readonly precedence: number;
  readonly label: number;
  readonly sourceLabel: number;
  readonly commonPrefix: number;
}

interface Unusable<T> {
  readonly usable: false;
  readonly item: T;
}

type Ranked<T> = Usable<T> | Unusable<T>;

function rank<T>(
  item: T, address: SelectableAddress, source: SelectableAddress | null, table: readonly PolicyEntry[],
): Ranked<T> {
  if (source === null) return { usable: false, item };
  const policy = policyOf(address, table);
  return {
    usable: true,
    item,
    address,
    scope: addressScope(address),
    sourceScope: addressScope(source),
    precedence: policy.precedence,
    label: policy.label,
    sourceLabel: policyOf(source, table).label,
    commonPrefix: commonPrefixLength(address, source),
  };
}

const preferFirst = (condition: boolean, otherCondition: boolean): number =>
  condition === otherCondition ? 0 : condition ? -1 : 1;

function compareDestinations<T>(left: Ranked<T>, right: Ranked<T>): number {
  if (!left.usable || !right.usable) return preferFirst(left.usable, right.usable);

  const matchingScope = preferFirst(left.scope === left.sourceScope, right.scope === right.sourceScope);
  if (matchingScope !== 0) return matchingScope;

  const matchingLabel = preferFirst(left.label === left.sourceLabel, right.label === right.sourceLabel);
  if (matchingLabel !== 0) return matchingLabel;

  if (left.precedence !== right.precedence) return left.precedence > right.precedence ? -1 : 1;

  if (left.scope !== right.scope) return left.scope < right.scope ? -1 : 1;

  const sameFamily = (left.address instanceof IPAddress) === (right.address instanceof IPAddress);
  if (sameFamily && left.commonPrefix !== right.commonPrefix) return left.commonPrefix > right.commonPrefix ? -1 : 1;

  return 0;
}

export function orderDestinations<T>(
  candidates: readonly T[],
  addressOf: (candidate: T) => SelectableAddress,
  port: DestinationSelectionPort,
  table: readonly PolicyEntry[] = DEFAULT_POLICY_TABLE,
): T[] {
  return candidates
    .map((candidate) => {
      const address = addressOf(candidate);
      return rank(candidate, address, port.sourceFor(address), table);
    })
    .sort(compareDestinations)
    .map((ranked) => ranked.item);
}
