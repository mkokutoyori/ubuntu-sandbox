import { prefixLengthToMaskUint32, tryIpToUint32, uint32ToIp } from '../../../core/ip';

export type AddressObjectKind =
  | 'host'
  | 'subnet'
  | 'range'
  | 'fqdn'
  | 'wildcard'
  | 'geography'
  | 'dynamic'
  | 'vip'
  | 'any';

export type AddressFamily = 'ipv4' | 'ipv6';

export interface AddressObject {
  readonly name: string;
  readonly kind: AddressObjectKind;
  readonly family: AddressFamily;
  readonly value?: string;
  readonly endValue?: string;
  readonly careMask?: string;
  readonly fqdn?: string;
  readonly countryCode?: string;
  readonly tagFilter?: string;
  readonly natRuleId?: string;
  readonly predefined: boolean;
  readonly tags: readonly string[];
  readonly comment?: string;
}

export interface AddressMatchContext {
  resolveFqdn?: (fqdn: string) => readonly string[];
  countryOf?: (ip: string) => string | undefined;
  addressesWithTags?: (filter: string) => readonly string[];
}

export interface AddressObjectOptions {
  comment?: string;
  tags?: readonly string[];
  predefined?: boolean;
  family?: AddressFamily;
}

function build(
  fields: Omit<AddressObject, 'predefined' | 'tags' | 'family'>,
  options: AddressObjectOptions,
): AddressObject {
  return Object.freeze({
    ...fields,
    family: options.family ?? 'ipv4',
    predefined: options.predefined ?? false,
    tags: Object.freeze([...(options.tags ?? [])]),
    comment: options.comment,
  });
}

export function hostAddress(name: string, value: string, options: AddressObjectOptions = {}): AddressObject {
  return build({ name, kind: 'host', value }, options);
}

export function subnetAddress(
  name: string, network: string, mask: string | number, options: AddressObjectOptions = {},
): AddressObject {
  return build({ name, kind: 'subnet', value: network, careMask: normaliseMask(mask) }, options);
}

export function wildcardAddress(
  name: string, network: string, careMask: string, options: AddressObjectOptions = {},
): AddressObject {
  return build({ name, kind: 'wildcard', value: network, careMask }, options);
}

export function addressFromCiscoWildcard(
  name: string, network: string, ciscoWildcard: string, options: AddressObjectOptions = {},
): AddressObject {
  return wildcardAddress(name, network, invertMask(ciscoWildcard), options);
}

export function rangeAddress(
  name: string, from: string, to: string, options: AddressObjectOptions = {},
): AddressObject {
  return build({ name, kind: 'range', value: from, endValue: to }, options);
}

export function fqdnAddress(name: string, fqdn: string, options: AddressObjectOptions = {}): AddressObject {
  return build({ name, kind: 'fqdn', fqdn }, options);
}

export function geographyAddress(
  name: string, countryCode: string, options: AddressObjectOptions = {},
): AddressObject {
  return build({ name, kind: 'geography', countryCode }, options);
}

export function dynamicAddress(
  name: string, tagFilter: string, options: AddressObjectOptions = {},
): AddressObject {
  return build({ name, kind: 'dynamic', tagFilter }, options);
}

export function vipAddress(
  name: string, mappedAddress: string, natRuleId: string,
  mappedEndAddress?: string, options: AddressObjectOptions = {},
): AddressObject {
  return build(
    { name, kind: 'vip', value: mappedAddress, endValue: mappedEndAddress, natRuleId },
    options,
  );
}

export function anyAddress(name = 'any'): AddressObject {
  return build({ name, kind: 'any' }, { predefined: true });
}

export function anyAddress6(name = 'all6'): AddressObject {
  return build({ name, kind: 'any' }, { predefined: true, family: 'ipv6' });
}

export function prefixAddress6(
  name: string, prefix: string, prefixLength: number,
  options: AddressObjectOptions = {},
): AddressObject {
  return build(
    { name, kind: 'subnet', value: prefix, careMask: String(prefixLength) },
    { ...options, family: 'ipv6' },
  );
}

export function rangeAddress6(
  name: string, from: string, to: string, options: AddressObjectOptions = {},
): AddressObject {
  return build({ name, kind: 'range', value: from, endValue: to },
    { ...options, family: 'ipv6' });
}

export function familyOf(candidate: string): AddressFamily {
  return candidate.includes(':') ? 'ipv6' : 'ipv4';
}

export function addressObjectMatches(
  object: AddressObject, candidate: string, context: AddressMatchContext,
): boolean {
  if (object.family !== familyOf(candidate)) return false;
  if (object.kind === 'any') return true;
  if (object.family === 'ipv6') return matchesIpv6(object, candidate);

  switch (object.kind) {
    case 'host':
      return sameAddress(candidate, object.value);
    case 'vip':
      return object.endValue === undefined
        ? sameAddress(candidate, object.value)
        : matchesRange(candidate, object.value, object.endValue);
    case 'subnet':
    case 'wildcard':
      return matchesCareMask(candidate, object.value, object.careMask);
    case 'range':
      return matchesRange(candidate, object.value, object.endValue);
    case 'fqdn':
      return matchesResolved(candidate, object.fqdn, context.resolveFqdn);
    case 'geography':
      return object.countryCode !== undefined
        && context.countryOf?.(candidate) === object.countryCode;
    case 'dynamic':
      return object.tagFilter !== undefined
        && (context.addressesWithTags?.(object.tagFilter) ?? []).some(a => sameAddress(candidate, a));
    default:
      return false;
  }
}

function matchesIpv6(object: AddressObject, candidate: string): boolean {
  const value = tryIpv6ToBits(candidate);
  if (value === null) return false;

  switch (object.kind) {
    case 'host':
      return sameIpv6(value, object.value);
    case 'subnet':
      return withinIpv6Prefix(value, object.value, object.careMask);
    case 'range':
      return withinIpv6Range(value, object.value, object.endValue);
    default:
      return false;
  }
}

function sameIpv6(value: bigint, other: string | undefined): boolean {
  const compared = other === undefined ? null : tryIpv6ToBits(other);
  return compared !== null && compared === value;
}

function withinIpv6Prefix(
  value: bigint, prefix: string | undefined, length: string | undefined,
): boolean {
  if (prefix === undefined || length === undefined) return false;
  const base = tryIpv6ToBits(prefix);
  const bits = Number.parseInt(length, 10);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 128) return false;
  const mask = bits === 0
    ? 0n
    : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
  return (value & mask) === (base & mask);
}

function withinIpv6Range(
  value: bigint, from: string | undefined, to: string | undefined,
): boolean {
  if (from === undefined || to === undefined) return false;
  const low = tryIpv6ToBits(from);
  const high = tryIpv6ToBits(to);
  if (low === null || high === null || low > high) return false;
  return value >= low && value <= high;
}

export function tryIpv6ToBits(value: string): bigint | null {
  const text = value.split('%')[0]?.trim() ?? '';
  if (!text.includes(':')) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;

  const expand = (part: string): string[] =>
    part.length === 0 ? [] : part.split(':');
  const head = expand(halves[0] ?? '');
  const tail = halves.length === 2 ? expand(halves[1] ?? '') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null;

  const groups = halves.length === 2
    ? [...head, ...Array<string>(missing).fill('0'), ...tail]
    : head;
  if (groups.length !== 8) return null;

  let bits = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    bits = (bits << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return bits;
}

function sameAddress(candidate: string, value: string | undefined): boolean {
  if (value === undefined) return false;
  const a = tryIpToUint32(candidate);
  const b = tryIpToUint32(value);
  return a !== null && b !== null && a === b;
}

function matchesCareMask(
  candidate: string, network: string | undefined, careMask: string | undefined,
): boolean {
  if (network === undefined || careMask === undefined) return false;
  const value = tryIpToUint32(candidate);
  const base = tryIpToUint32(network);
  const care = tryIpToUint32(careMask);
  if (value === null || base === null || care === null) return false;
  return ((value & care) >>> 0) === ((base & care) >>> 0);
}

export function matchesRange(candidate: string, from: string | undefined, to: string | undefined): boolean {
  if (from === undefined || to === undefined) return false;
  const value = tryIpToUint32(candidate);
  const low = tryIpToUint32(from);
  const high = tryIpToUint32(to);
  if (value === null || low === null || high === null) return false;
  if (low > high) return false;
  return value >= low && value <= high;
}

function matchesResolved(
  candidate: string, fqdn: string | undefined, resolve: AddressMatchContext['resolveFqdn'],
): boolean {
  if (fqdn === undefined || resolve === undefined) return false;
  return resolve(fqdn).some(address => sameAddress(candidate, address));
}

function normaliseMask(mask: string | number): string {
  if (typeof mask === 'number') return uint32ToIp(prefixLengthToMaskUint32(mask));
  return mask;
}

function invertMask(mask: string): string {
  const value = tryIpToUint32(mask);
  if (value === null) return mask;
  return uint32ToIp((~value) >>> 0);
}
