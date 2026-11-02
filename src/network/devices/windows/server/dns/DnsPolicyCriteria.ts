import { IPAddress, IPv6Address } from '@/network/core/types';
import { isValidIPv6 } from '@/network/core/ip';
import { validateDnsName } from '@/network/dns/wire/ResourceRecord';
import { isWithinDomain, normalizeDnsName } from '@/network/dns/wire/DnsName';

export type PolicyCondition = 'AND' | 'OR';

export const POLICY_CONDITIONS: readonly PolicyCondition[] = ['AND', 'OR'];

export interface CriterionExpression {
  readonly equal: readonly string[];
  readonly different: readonly string[];
}

const EQUAL = 'EQ';
const DIFFERENT = 'NE';

export function parseCriterion(text: string): CriterionExpression | null {
  const tokens = text.split(',').map(token => token.trim());
  while (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop();
  const equal: string[] = [];
  const different: string[] = [];
  let current: string[] | null = null;
  let seenEqual = false;
  let seenDifferent = false;
  for (const token of tokens) {
    const comparator = token.toUpperCase();
    if (comparator === EQUAL || comparator === DIFFERENT) {
      if (current !== null && current.length === 0) return null;
      const seen = comparator === EQUAL ? seenEqual : seenDifferent;
      if (seen) return null;
      if (comparator === EQUAL) seenEqual = true;
      else seenDifferent = true;
      current = comparator === EQUAL ? equal : different;
    } else if (current === null || token === '') {
      return null;
    } else {
      current.push(token);
    }
  }
  if (current === null || current.length === 0) return null;
  return { equal, different };
}

export function criterionText(expression: CriterionExpression): string {
  const parts: string[] = [];
  if (expression.equal.length > 0) parts.push(EQUAL, ...expression.equal);
  if (expression.different.length > 0) parts.push(DIFFERENT, ...expression.different);
  return parts.join(',');
}

export function evaluateCriterion(
  expression: CriterionExpression, condition: PolicyCondition, matches: (value: string) => boolean,
): boolean {
  const parts: boolean[] = [];
  if (expression.equal.length > 0) parts.push(expression.equal.some(matches));
  if (expression.different.length > 0) parts.push(expression.different.every(value => !matches(value)));
  if (parts.length === 0) return false;
  return condition === 'AND' ? parts.every(part => part) : parts.some(part => part);
}

export function isValidCriterionFqdn(value: string): boolean {
  if (value === '*') return true;
  const name = value.startsWith('*.') ? value.slice(2) : value;
  if (name === '' || /[\s*]/.test(name)) return false;
  try {
    validateDnsName(name);
    return true;
  } catch {
    return false;
  }
}

export function fqdnCriterionMatches(value: string, queryName: string): boolean {
  const queried = normalizeDnsName(queryName);
  if (value === '*') return true;
  if (value.startsWith('*.')) return isWithinDomain(queried, normalizeDnsName(value.slice(2)));
  return queried === normalizeDnsName(value);
}

export function isValidCriterionAddress(value: string): boolean {
  return IPAddress.isValid(value) || isValidIPv6(value);
}

export function addressCriterionMatches(value: string, address: IPAddress | IPv6Address): boolean {
  return address instanceof IPAddress
    ? IPAddress.isValid(value) && new IPAddress(value).equals(address)
    : isValidIPv6(value) && new IPv6Address(value).equals(address);
}
