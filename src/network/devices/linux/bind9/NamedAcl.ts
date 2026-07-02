import { IPAddress } from '@/network/core/types';
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
  | { readonly kind: 'reference'; readonly list: AddressMatchList; readonly negated: boolean };

const ADDRESS_PATTERN = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?:\/(\d{1,2}))?$/;
const LOOPBACK_PREFIX: AclNetwork = { address: '127.0.0.0', prefix: 8 };
const FULL_PREFIX = 32;

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

  matches(ip: string, env: AclHostEnvironment): boolean {
    const address = toUint32(ip);
    if (address === null) return false;
    for (const element of this.elements) {
      if (elementMatches(element, address, env)) return !element.negated;
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
  if (values.length !== 1 || statement.block !== null) {
    throw new NamedConfigError(statement.file, statement.line, 'invalid address match list element');
  }

  const value = values[0];
  const text = value.text;

  if (!value.quoted) {
    if (text === 'any' || text === 'none' || text === 'localhost' || text === 'localnets') {
      return { kind: text, negated };
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

function elementMatches(element: AclElement, address: number, env: AclHostEnvironment): boolean {
  switch (element.kind) {
    case 'any':
      return true;
    case 'none':
      return false;
    case 'localhost':
      return matchesLocalhost(address, env);
    case 'localnets':
      return matchesNetworks(address, env.localNetworks);
    case 'address':
      return inNetwork(address, element.base, element.prefix);
    case 'reference':
      return element.list.matches(IPAddress.fromUint32(address).toString(), env);
  }
}

function matchesLocalhost(address: number, env: AclHostEnvironment): boolean {
  const loopbackBase = toUint32(LOOPBACK_PREFIX.address);
  if (loopbackBase !== null && inNetwork(address, loopbackBase, LOOPBACK_PREFIX.prefix)) return true;
  return env.localAddresses.some((local) => toUint32(local) === address);
}

function matchesNetworks(address: number, networks: readonly AclNetwork[]): boolean {
  return networks.some((network) => {
    const base = toUint32(network.address);
    return base !== null && inNetwork(address, base, network.prefix);
  });
}
