import { IPv6Address } from '../../core/types';
import type { PolicyEntry } from '../../layers/internet/DestinationSelection';
import { applyCimCriteria, cimNotFound } from './cimQuery';
import { policyPrefixText } from './PrefixPolicyStore';

export const NET_PREFIX_POLICY_CIM_CLASS = 'MSFT_NetPrefixPolicy';

export type NetPrefixPolicyStore = 'Persistent' | 'Active';

export interface NetPrefixPolicyRow {
  prefix: string;
  precedence: number;
  label: number;
  store: NetPrefixPolicyStore;
}

export interface NetPrefixPolicySelection {
  prefix?: string[];
  precedence?: string[];
  label?: string[];
}

export function prefixPolicyRowsOf(
  entries: readonly PolicyEntry[], store: NetPrefixPolicyStore,
): NetPrefixPolicyRow[] {
  return entries.map(entry => ({
    prefix: policyPrefixText(entry), precedence: entry.precedence, label: entry.label, store,
  }));
}

export function canonicalPolicyPrefix(text: string): string {
  const slash = text.lastIndexOf('/');
  const address = slash < 0 ? null : IPv6Address.tryParse(text.slice(0, slash));
  return address === null ? text : `${address}${text.slice(slash)}`;
}

export function selectNetPrefixPolicies<T extends NetPrefixPolicyRow>(
  rows: readonly T[], selection: NetPrefixPolicySelection,
): T[] {
  return applyCimCriteria(rows, [
    [selection.prefix?.map(canonicalPolicyPrefix), r => r.prefix],
    [selection.precedence, r => String(r.precedence)],
    [selection.label, r => String(r.label)],
  ]);
}

export function prefixPolicySelectionIsEmpty(selection: NetPrefixPolicySelection): boolean {
  return Object.values(selection).every(v => v === undefined);
}

export function noMatchingNetPrefixPolicy(selection: NetPrefixPolicySelection): string {
  return cimNotFound(NET_PREFIX_POLICY_CIM_CLASS, [
    ['Prefix', selection.prefix],
    ['Precedence', selection.precedence],
    ['Label', selection.label],
  ]);
}
