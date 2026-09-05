import {
  ipToUint32, isValidIPv4, prefixLengthToMaskUint32, tryIpToUint32, wildcardMatches,
} from '../../../core/ip';
import type { IpPrefixEntry } from '../../router/policy/IpPrefixList';

export type AccessListAction = 'permit' | 'deny';

export interface AccessListPrefix {
  readonly any: boolean;
  readonly network: string;
  readonly mask: string;
}

export interface AccessListRule {
  readonly id: number;
  readonly action: AccessListAction;
  readonly prefix: AccessListPrefix;
  readonly wildcard?: string;
  readonly exactMatch: boolean;
}

export interface PrefixList {
  readonly name: string;
  readonly comments?: string;
  readonly rules: readonly IpPrefixEntry[];
}

export interface AccessList {
  readonly name: string;
  readonly comments?: string;
  readonly rules: readonly AccessListRule[];
}

export const ANY_PREFIX: AccessListPrefix =
  Object.freeze({ any: true, network: '0.0.0.0', mask: '0.0.0.0' });

export function parseAccessListPrefix(tokens: readonly string[]): AccessListPrefix | null {
  if (tokens.length === 1 && tokens[0] === 'any') return ANY_PREFIX;
  if (tokens.length !== 2) return null;

  const [network, mask] = tokens;
  if (!isValidIPv4(network) || !isValidIPv4(mask)) return null;
  if (!isContiguousMask(mask)) return null;
  return { any: false, network, mask };
}

export function maskPrefixLength(mask: string): number {
  const value = tryIpToUint32(mask);
  if (value === null) return 0;
  let bits = 0;
  for (let index = 31; index >= 0; index--) {
    if (((value >>> index) & 1) === 0) break;
    bits++;
  }
  return bits;
}

function isContiguousMask(mask: string): boolean {
  const value = ipToUint32(mask);
  return prefixLengthToMaskUint32(maskPrefixLength(mask)) === value;
}

export class AccessListStore {
  private readonly lists = new Map<string, AccessList>();

  upsert(list: AccessList): void { this.lists.set(list.name, list); }

  remove(name: string): boolean { return this.lists.delete(name); }

  get(name: string): AccessList | undefined { return this.lists.get(name); }

  names(): readonly string[] { return Object.freeze([...this.lists.keys()]); }

  all(): readonly AccessList[] { return Object.freeze([...this.lists.values()]); }

  clear(): void { this.lists.clear(); }
}

export function accessListPermits(
  list: AccessList, network: string, prefixLength: number,
): boolean {
  return evaluateAccessList(list, network, prefixLength) === 'permit';
}

export function evaluateAccessList(
  list: AccessList, network: string, prefixLength: number,
): AccessListAction {
  for (const rule of [...list.rules].sort((left, right) => left.id - right.id)) {
    if (ruleMatches(rule, network, prefixLength)) return rule.action;
  }
  return 'deny';
}

function ruleMatches(
  rule: AccessListRule, network: string, prefixLength: number,
): boolean {
  if (rule.prefix.any) return true;
  if (tryIpToUint32(network) === null) return false;

  if (rule.wildcard !== undefined) {
    return wildcardMatches(network, rule.prefix.network, rule.wildcard);
  }

  const declared = maskPrefixLength(rule.prefix.mask);
  if (rule.exactMatch && prefixLength !== declared) return false;
  if (prefixLength < declared) return false;

  const mask = prefixLengthToMaskUint32(declared);
  return (ipToUint32(network) & mask) === (ipToUint32(rule.prefix.network) & mask);
}
