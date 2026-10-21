import { IPAddress, IPv6Address } from '@/network/core/types';
import { ipv6MatchesPrefix } from '@/network/core/RoutingTable';
import { NamedConfigError } from './NamedConfigError';
import type { NamedConfStatement } from './NamedConfParser';

export interface AclNetwork {
  readonly address: string;
  readonly prefix: number;
}

export interface AclHostEnvironment {
  readonly localAddresses: readonly string[];
  readonly localNetworks: readonly AclNetwork[];
}

type AclElement =
  | { readonly kind: 'any'; readonly negated: boolean }
  | { readonly kind: 'none'; readonly negated: boolean }
  | { readonly kind: 'localhost'; readonly negated: boolean }
  | { readonly kind: 'localnets'; readonly negated: boolean }
  | { readonly kind: 'address'; readonly base: number; readonly prefix: number; readonly negated: boolean }
  | { readonly kind: 'address6'; readonly base: IPv6Address; readonly prefix: number; readonly negated: boolean }
  | { readonly kind: 'reference'; readonly list: AddressMatchList; readonly negated: boolean }
  | { readonly kind: 'key'; readonly name: string; readonly negated: boolean };

const ADDRESS_PATTERN = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?:\/(\d{1,2}))?$/;
const LOOPBACK_PREFIX: AclNetwork = { address: '127.0.0.0', prefix: 8 };
const FULL_PREFIX = 32;
const FULL_PREFIX_6 = 128;
const ADDRESS_6_PATTERN = /^([0-9a-fA-F:.]+:[0-9a-fA-F:.]*)(?:\/(\d{1,3}))?$/;

interface Client {
  readonly v4: number | null;
  readonly v6: IPv6Address | null;
}

function prefixMask(prefix: number): number {
  return prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
}

function inNetwork(ip: number, base: number, prefix: number): boolean {
  const mask = prefixMask(prefix);
  return ((ip & mask) >>> 0) === ((base & mask) >>> 0);
}

function toUint32(ip: string): number | null {
  const parsed = IPAddress.tryParse(ip);
  return parsed ? parsed.toUint32() : null;
}

export class AddressMatchList {
  private constructor(private readonly elements: readonly AclElement[]) {}

  static any(): AddressMatchList {
    return new AddressMatchList([{ kind: 'any', negated: false }]);
  }

  static none(): AddressMatchList {
    return new AddressMatchList([{ kind: 'none', negated: false }]);
  }

  static localTrust(): AddressMatchList {
    return new AddressMatchList([
      { kind: 'localnets', negated: false },
      { kind: 'localhost', negated: false },
    ]);
  }

  static fromStatements(
    statements: readonly NamedConfStatement[],
    namedAcls: ReadonlyMap<string, AddressMatchList>,
  ): AddressMatchList {
    const elements: AclElement[] = [];
    for (const statement of statements) {
      elements.push(parseElement(statement, namedAcls));
    }
    return new AddressMatchList(elements);
  }

  grantsNothing(): boolean {
    return this.elements.every((element) => element.kind === 'none');
  }

  matches(ip: string, env: AclHostEnvironment, signingKey: string | null = null): boolean {
    const client: Client = { v4: toUint32(ip), v6: IPv6Address.tryParse(ip) };
    for (const element of this.elements) {
      if (elementMatches(element, client, env, signingKey)) return !element.negated;
    }
    return false;
  }
}

function parseElement(
  statement: NamedConfStatement,
  namedAcls: ReadonlyMap<string, AddressMatchList>,
): AclElement {
  let negated = false;
  let values = [...statement.values];
  if (values[0]?.text === '!') {
    negated = true;
    values = values.slice(1);
  }
  if (values.length === 2 && values[0].text === 'key' && !values[0].quoted && statement.block === null) {
    return { kind: 'key', name: values[1].text.toLowerCase().replace(/\.$/, ''), negated };
  }
  if (values.length !== 1 || statement.block !== null) {
    throw new NamedConfigError(statement.file, statement.line, 'invalid address match list element');
  }

  const value = values[0];
  const text = value.text;

  if (!value.quoted) {
    if (text === 'any' || text === 'none' || text === 'localhost' || text === 'localnets') {
      return { kind: text, negated };
    }
    const address6Match = ADDRESS_6_PATTERN.exec(text);
    if (address6Match) {
      const base = IPv6Address.tryParse(address6Match[1]);
      const prefix = address6Match[2] === undefined ? FULL_PREFIX_6 : Number(address6Match[2]);
      if (base === null || prefix > FULL_PREFIX_6) {
        throw new NamedConfigError(statement.file, statement.line, `expected IP address near '${text}'`);
      }
      return { kind: 'address6', base, prefix, negated };
    }
    const addressMatch = ADDRESS_PATTERN.exec(text);
    if (addressMatch) {
      const base = toUint32(addressMatch[1]);
      const prefix = addressMatch[2] === undefined ? FULL_PREFIX : Number(addressMatch[2]);
      if (base === null || prefix > FULL_PREFIX) {
        throw new NamedConfigError(statement.file, statement.line, `expected IP address near '${text}'`);
      }
      return { kind: 'address', base, prefix, negated };
    }
  }

  const referenced = namedAcls.get(text);
  if (!referenced) {
    throw new NamedConfigError(statement.file, statement.line, `undefined ACL '${text}'`);
  }
  return { kind: 'reference', list: referenced, negated };
}

function elementMatches(
  element: AclElement, client: Client, env: AclHostEnvironment, signingKey: string | null,
): boolean {
  switch (element.kind) {
    case 'any':
      return true;
    case 'none':
      return false;
    case 'localhost':
      return matchesLocalhost(client, env);
    case 'localnets':
      return matchesNetworks(client, env.localNetworks);
    case 'address':
      return client.v4 !== null && inNetwork(client.v4, element.base, element.prefix);
    case 'address6':
      return client.v6 !== null && ipv6MatchesPrefix(client.v6, element.base, element.prefix);
    case 'reference':
      return element.list.matches(client.v4 === null ? (client.v6?.toString() ?? '') : IPAddress.fromUint32(client.v4).toString(), env, signingKey);
    case 'key':
      return signingKey !== null && signingKey === element.name;
  }
}

function matchesLocalhost(client: Client, env: AclHostEnvironment): boolean {
  if (client.v6 !== null) {
    return client.v6.isLoopback() || env.localAddresses.some((local) => IPv6Address.tryParse(local)?.equals(client.v6!) === true);
  }
  if (client.v4 === null) return false;
  const loopbackBase = toUint32(LOOPBACK_PREFIX.address);
  if (loopbackBase !== null && inNetwork(client.v4, loopbackBase, LOOPBACK_PREFIX.prefix)) return true;
  return env.localAddresses.some((local) => toUint32(local) === client.v4);
}

function matchesNetworks(client: Client, networks: readonly AclNetwork[]): boolean {
  return networks.some((network) => {
    if (client.v6 !== null) {
      const base = IPv6Address.tryParse(network.address);
      return base !== null && ipv6MatchesPrefix(client.v6, base, network.prefix);
    }
    const base = toUint32(network.address);
    return client.v4 !== null && base !== null && inNetwork(client.v4, base, network.prefix);
  });
}
