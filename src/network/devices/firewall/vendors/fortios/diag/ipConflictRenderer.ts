import type { IpConflictCacheEntry } from '../../../l3/IpConflictDetection';

const CACHE_HEADER = ['index', 'IPv4 address', 'MAC', 'dev', 'vlanid'];

export function renderIpConflictCache(
  entries: readonly IpConflictCacheEntry[], vlanIdOf: (iface: string) => string | undefined,
): string {
  const rows = entries.map((entry) => {
    const vlanId = vlanIdOf(entry.iface);
    return [String(entry.index), entry.address, entry.mac.toString(), entry.iface,
      ...(vlanId === undefined ? [] : [vlanId])].join('\t');
  });
  return [CACHE_HEADER.join('\t'), ...rows].join('\n');
}

export function renderIpConflictProbes(entries: readonly IpConflictCacheEntry[]): string {
  return entries.map((entry) => `Sending probe for ${entry.address} via ${entry.iface}.`).join('\n');
}
