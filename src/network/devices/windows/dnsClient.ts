import { applyCimCriteria, cimNotFound } from './cimQuery';
import type { NrptRule } from './dnsClientSettings';

export interface DnsClientRow {
  interfaceAlias: string;
  interfaceIndex: number;
  connectionSpecificSuffix: string;
  registerThisConnectionsAddress: boolean;
  useSuffixWhenRegistering: boolean;
}

export interface DnsClientSelection {
  interfaceAlias?: string[];
  interfaceIndex?: string[];
  connectionSpecificSuffix?: string[];
  registerThisConnectionsAddress?: string[];
  useSuffixWhenRegistering?: string[];
}

export function selectDnsClients<T extends DnsClientRow>(rows: readonly T[], selection: DnsClientSelection): T[] {
  return applyCimCriteria(rows, [
    [selection.interfaceAlias, r => r.interfaceAlias],
    [selection.interfaceIndex, r => String(r.interfaceIndex)],
    [selection.connectionSpecificSuffix, r => r.connectionSpecificSuffix],
    [selection.registerThisConnectionsAddress, r => String(r.registerThisConnectionsAddress)],
    [selection.useSuffixWhenRegistering, r => String(r.useSuffixWhenRegistering)],
  ]);
}

export function dnsClientSelectionIsEmpty(selection: DnsClientSelection): boolean {
  return Object.values(selection).every(v => v === undefined);
}

export function noMatchingDnsClient(selection: DnsClientSelection): string {
  return cimNotFound('MSFT_DNSClient', [
    ['InterfaceAlias', selection.interfaceAlias],
    ['InterfaceIndex', selection.interfaceIndex],
    ['ConnectionSpecificSuffix', selection.connectionSpecificSuffix],
    ['RegisterThisConnectionsAddress', selection.registerThisConnectionsAddress],
    ['UseSuffixWhenRegistering', selection.useSuffixWhenRegistering],
  ]);
}

export const NRPT_ENCODINGS = ['Disable', 'Utf8WithMapping', 'Utf8WithoutMapping', 'Punycode'] as const;
export const NRPT_IPSEC_ENCRYPTIONS = ['None', 'Low', 'Medium', 'High'] as const;
export const NRPT_PROXY_TYPES = ['NoProxy', 'UseDefault', 'UseProxyName'] as const;
export const NRPT_QUERY_POLICIES = ['Disable', 'QueryIPv6Only', 'QueryBoth'] as const;
export const NRPT_FALLBACKS = ['Disable', 'FallbackSecure', 'FallbackUnsecure', 'FallbackPrivate'] as const;
export const NRPT_DA_NETWORKS = ['EnableOnNetworkID', 'EnableAlways', 'Disable', 'DisableDA'] as const;

export function devolvedSuffixes(primarySuffix: string, level: number): string[] {
  const labels = primarySuffix.split('.').filter(label => label !== '');
  const kept = level > 0 ? level : 2;
  const parents: string[] = [];
  for (let drop = 1; labels.length - drop >= kept; drop++) parents.push(labels.slice(drop).join('.'));
  return parents;
}

function normalizedNamespace(namespace: string): string {
  return namespace.toLowerCase().replace(/\.$/, '');
}

function namespaceSpecificity(namespace: string, queryName: string): number {
  const space = normalizedNamespace(namespace);
  const name = normalizedNamespace(queryName);
  if (space === '') return 0;
  if (space.startsWith('.')) {
    const zone = space.slice(1);
    return name === zone || name.endsWith(space) ? zone.split('.').length + 1 : -1;
  }
  return name === space ? 1000 : -1;
}

export function nrptRuleFor(rules: readonly NrptRule[], queryName: string): NrptRule | null {
  let best: NrptRule | null = null;
  let bestScore = -1;
  for (const rule of rules) {
    for (const namespace of rule.namespaces) {
      const score = namespaceSpecificity(namespace, queryName);
      if (score > bestScore) {
        best = rule;
        bestScore = score;
      }
    }
  }
  return best;
}
