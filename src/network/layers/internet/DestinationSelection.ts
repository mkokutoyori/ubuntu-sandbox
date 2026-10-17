import { IPAddress, IPv6Address } from '../../core/types';
import { ipv6ToBigInt } from '../../core/Ipv6Arithmetic';

export type SelectableAddress = IPAddress | IPv6Address;

export interface PolicyEntry {
  readonly prefix: IPv6Address;
  readonly length: number;
  readonly precedence: number;
  readonly label: number;
}

export interface PrefixValue {
  readonly prefix: IPv6Address;
  readonly length: number;
  readonly value: number;
}

export interface Ipv4Scope {
  readonly address: IPAddress;
  readonly length: number;
  readonly scope: number;
}

export type Ipv4CommonPrefix = 'mapped' | 'same-subnet';

export interface DestinationPolicy {
  readonly labels: readonly PrefixValue[];
  readonly precedences: readonly PrefixValue[];
  readonly ipv4Scopes: readonly Ipv4Scope[];
  readonly ipv4CommonPrefix: Ipv4CommonPrefix;
}

export interface SourceFacts {
  readonly address: SelectableAddress;
  readonly deprecated?: boolean;
  readonly home?: boolean;
  readonly native?: boolean;
  readonly interfaceIndex?: number;
  readonly prefixLength?: number;
}

export interface DestinationSelectionPort {
  sourceFor(destination: SelectableAddress): SourceFacts | null;
}

const SCOPE_LINK_LOCAL = 2;
const SCOPE_SITE_LOCAL = 5;
const SCOPE_GLOBAL = 14;
const ABSENT_LABEL = -1;
const ABSENT_PRECEDENCE = 0;

const SITE_LOCAL_PREFIX = new IPv6Address('fec0::');

const policyEntry = (prefix: string, length: number, precedence: number, label: number): PolicyEntry =>
  ({ prefix: new IPv6Address(prefix), length, precedence, label });

const prefixValue = (prefix: string, length: number, value: number): PrefixValue =>
  ({ prefix: new IPv6Address(prefix), length, value });

const ipv4Scope = (address: string, length: number, scope: number): Ipv4Scope =>
  ({ address: new IPAddress(address), length, scope });

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

export const DEFAULT_IPV4_SCOPES: readonly Ipv4Scope[] = [
  ipv4Scope('169.254.0.0', 16, SCOPE_LINK_LOCAL),
  ipv4Scope('127.0.0.0', 8, SCOPE_LINK_LOCAL),
  ipv4Scope('0.0.0.0', 0, SCOPE_GLOBAL),
];

export const GLIBC_LABELS: readonly PrefixValue[] = [
  prefixValue('::1', 128, 0),
  prefixValue('2002::', 16, 2),
  prefixValue('::', 96, 3),
  prefixValue('::ffff:0:0', 96, 4),
  prefixValue('fec0::', 10, 5),
  prefixValue('fc00::', 7, 6),
  prefixValue('2001::', 32, 7),
  prefixValue('::', 0, 1),
];

export const GLIBC_PRECEDENCES: readonly PrefixValue[] = [
  prefixValue('::1', 128, 50),
  prefixValue('2002::', 16, 30),
  prefixValue('::', 96, 20),
  prefixValue('::ffff:0:0', 96, 10),
  prefixValue('::', 0, 40),
];

export function policyFromTable(table: readonly PolicyEntry[]): DestinationPolicy {
  return {
    labels: table.map((row) => ({ prefix: row.prefix, length: row.length, value: row.label })),
    precedences: table.map((row) => ({ prefix: row.prefix, length: row.length, value: row.precedence })),
    ipv4Scopes: DEFAULT_IPV4_SCOPES,
    ipv4CommonPrefix: 'mapped',
  };
}

export const RFC6724_POLICY: DestinationPolicy = policyFromTable(DEFAULT_POLICY_TABLE);

export const GLIBC_POLICY: DestinationPolicy = {
  labels: GLIBC_LABELS,
  precedences: GLIBC_PRECEDENCES,
  ipv4Scopes: DEFAULT_IPV4_SCOPES,
  ipv4CommonPrefix: 'same-subnet',
};

export function ipv4MappedAddress(address: IPAddress): IPv6Address {
  const [a, b, c, d] = address.getOctets();
  return new IPv6Address([0, 0, 0, 0, 0, 0xffff, (a << 8) | b, (c << 8) | d]);
}

const asIpv6 = (address: SelectableAddress): IPv6Address =>
  address instanceof IPAddress ? ipv4MappedAddress(address) : address;

function valueOf(address: SelectableAddress, table: readonly PrefixValue[], absent: number): number {
  const probe = asIpv6(address);
  let best: PrefixValue | null = null;
  for (const row of table) {
    if (!probe.isInSameSubnet(row.prefix, row.length)) continue;
    if (best === null || row.length > best.length) best = row;
  }
  return best === null ? absent : best.value;
}

export const labelOf = (address: SelectableAddress, policy: DestinationPolicy): number =>
  valueOf(address, policy.labels, ABSENT_LABEL);

export const precedenceOf = (address: SelectableAddress, policy: DestinationPolicy): number =>
  valueOf(address, policy.precedences, ABSENT_PRECEDENCE);

export function policyOf(
  address: SelectableAddress, table: readonly PolicyEntry[] = DEFAULT_POLICY_TABLE,
): { readonly precedence: number; readonly label: number } {
  const policy = policyFromTable(table);
  return { precedence: precedenceOf(address, policy), label: labelOf(address, policy) };
}

const ipv4Mask = (length: number): number => (length === 0 ? 0 : (0xffffffff << (32 - length)) >>> 0);

const sameIpv4Network = (left: IPAddress, right: IPAddress, length: number): boolean =>
  ((left.toUint32() & ipv4Mask(length)) >>> 0) === ((right.toUint32() & ipv4Mask(length)) >>> 0);

function ipv4ScopeOf(address: IPAddress, scopes: readonly Ipv4Scope[]): number {
  let best: Ipv4Scope | null = null;
  for (const row of scopes) {
    if (!sameIpv4Network(address, row.address, row.length)) continue;
    if (best === null || row.length > best.length) best = row;
  }
  return best === null ? SCOPE_GLOBAL : best.scope;
}

export function addressScope(
  address: SelectableAddress, ipv4Scopes: readonly Ipv4Scope[] = DEFAULT_IPV4_SCOPES,
): number {
  if (address instanceof IPAddress) return ipv4ScopeOf(address, ipv4Scopes);
  if (address.isMulticast()) return address.getHextets()[0] & 0xf;
  if (address.isLoopback() || address.isLinkLocal()) return SCOPE_LINK_LOCAL;
  return address.isInSameSubnet(SITE_LOCAL_PREFIX, 10) ? SCOPE_SITE_LOCAL : SCOPE_GLOBAL;
}

export function commonPrefixLength(left: SelectableAddress, right: SelectableAddress): number {
  const difference = ipv6ToBigInt(asIpv6(left)) ^ ipv6ToBigInt(asIpv6(right));
  return difference === 0n ? 128 : 128 - difference.toString(2).length;
}

function sameSubnetPrefix(destination: IPAddress, source: IPAddress, prefixLength: number): number {
  if (!sameIpv4Network(source, destination, prefixLength)) return 0;
  return Math.clz32(destination.toUint32() ^ source.toUint32());
}

function commonPrefixWith(address: SelectableAddress, source: SourceFacts, policy: DestinationPolicy): number {
  if (policy.ipv4CommonPrefix === 'same-subnet' && address instanceof IPAddress && source.address instanceof IPAddress) {
    return sameSubnetPrefix(address, source.address, source.prefixLength ?? 0);
  }
  return commonPrefixLength(address, source.address);
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
  readonly deprecated: boolean;
  readonly home: boolean;
  readonly native: boolean;
  readonly interfaceIndex: number | undefined;
}

interface Unusable<T> {
  readonly usable: false;
  readonly item: T;
  readonly scope: number;
  readonly precedence: number;
}

type Ranked<T> = Usable<T> | Unusable<T>;

function rank<T>(
  item: T, address: SelectableAddress, source: SourceFacts | null, policy: DestinationPolicy,
): Ranked<T> {
  const scope = addressScope(address, policy.ipv4Scopes);
  const precedence = precedenceOf(address, policy);
  if (source === null) return { usable: false, item, scope, precedence };
  return {
    usable: true,
    item,
    address,
    scope,
    sourceScope: addressScope(source.address, policy.ipv4Scopes),
    precedence,
    label: labelOf(address, policy),
    sourceLabel: labelOf(source.address, policy),
    commonPrefix: commonPrefixWith(address, source, policy),
    deprecated: source.deprecated === true,
    home: source.home === true,
    native: source.native !== false,
    interfaceIndex: source.interfaceIndex,
  };
}

const preferFirst = (condition: boolean, otherCondition: boolean): number =>
  condition === otherCondition ? 0 : condition ? -1 : 1;

function compareDestinations<T>(left: Ranked<T>, right: Ranked<T>): number {
  if (left.usable !== right.usable) return left.usable ? -1 : 1;

  if (left.usable && right.usable) {
    const matchingScope = preferFirst(left.scope === left.sourceScope, right.scope === right.sourceScope);
    if (matchingScope !== 0) return matchingScope;

    const notDeprecated = preferFirst(!left.deprecated, !right.deprecated);
    if (notDeprecated !== 0) return notDeprecated;

    const homeAddress = preferFirst(left.home, right.home);
    if (homeAddress !== 0) return homeAddress;

    const matchingLabel = preferFirst(left.label === left.sourceLabel, right.label === right.sourceLabel);
    if (matchingLabel !== 0) return matchingLabel;
  }

  if (left.precedence !== right.precedence) return left.precedence > right.precedence ? -1 : 1;

  if (left.usable && right.usable && left.interfaceIndex !== right.interfaceIndex) {
    const nativeTransport = preferFirst(left.native, right.native);
    if (nativeTransport !== 0) return nativeTransport;
  }

  if (left.scope !== right.scope) return left.scope < right.scope ? -1 : 1;

  if (left.usable && right.usable) {
    const sameFamily = (left.address instanceof IPAddress) === (right.address instanceof IPAddress);
    if (sameFamily && left.commonPrefix !== right.commonPrefix) return left.commonPrefix > right.commonPrefix ? -1 : 1;
  }

  return 0;
}

export function orderDestinations<T>(
  candidates: readonly T[],
  addressOf: (candidate: T) => SelectableAddress,
  port: DestinationSelectionPort,
  policy: DestinationPolicy = RFC6724_POLICY,
): T[] {
  return candidates
    .map((candidate) => {
      const address = addressOf(candidate);
      return rank(candidate, address, port.sourceFor(address), policy);
    })
    .sort(compareDestinations)
    .map((ranked) => ranked.item);
}
