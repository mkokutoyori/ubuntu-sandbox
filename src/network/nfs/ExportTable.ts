import { IPAddress } from '@/network/core/types';

export interface ExportClient {
  readonly pattern: string;
  readonly readOnly: boolean;
  readonly rootSquash: boolean;
  readonly allSquash: boolean;
  readonly anonUid: number;
  readonly anonGid: number;
  readonly secure: boolean;
  readonly sync: boolean;
  readonly subtreeCheck: boolean;
}

export interface ExportEntry {
  readonly path: string;
  readonly clients: readonly ExportClient[];
}

const DEFAULT_ANON = 65534;

export function parseExportOptions(text: string): Omit<ExportClient, 'pattern'> {
  const options = text.split(',').map((o) => o.trim()).filter(Boolean);
  let readOnly = true;
  let rootSquash = true;
  let allSquash = false;
  let anonUid = DEFAULT_ANON;
  let anonGid = DEFAULT_ANON;
  let secure = true;
  let sync = true;
  let subtreeCheck = false;
  for (const option of options) {
    const [name, value] = option.split('=', 2);
    switch (name) {
      case 'rw': readOnly = false; break;
      case 'ro': readOnly = true; break;
      case 'root_squash': rootSquash = true; break;
      case 'no_root_squash': rootSquash = false; break;
      case 'all_squash': allSquash = true; break;
      case 'no_all_squash': allSquash = false; break;
      case 'anonuid': anonUid = Number(value); break;
      case 'anongid': anonGid = Number(value); break;
      case 'secure': secure = true; break;
      case 'insecure': secure = false; break;
      case 'sync': sync = true; break;
      case 'async': sync = false; break;
      case 'subtree_check': subtreeCheck = true; break;
      case 'no_subtree_check': subtreeCheck = false; break;
      default: break;
    }
  }
  return { readOnly, rootSquash, allSquash, anonUid, anonGid, secure, sync, subtreeCheck };
}

export function parseExportsFile(content: string): ExportEntry[] {
  const entries: ExportEntry[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const match = /^("[^"]+"|\S+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const path = match[1].replace(/^"|"$/g, '');
    const clients: ExportClient[] = [];
    const clientPattern = /(\S+?)\(([^)]*)\)|(\S+)/g;
    let found: RegExpExecArray | null;
    while ((found = clientPattern.exec(match[2])) !== null) {
      const pattern = found[1] ?? found[3];
      const optionText = found[2] ?? '';
      clients.push({ pattern, ...parseExportOptions(optionText) });
    }
    if (clients.length === 0) {
      clients.push({ pattern: '*', ...parseExportOptions('') });
    }
    entries.push({ path, clients });
  }
  return entries;
}

function matchesWildcard(pattern: string, host: string): boolean {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^.]*')
    .replace(/\?/g, '.');
  return new RegExp(`^${expression}$`).test(host);
}

function matchesNetwork(pattern: string, ip: string): boolean {
  const slash = pattern.indexOf('/');
  if (slash < 0) return false;
  const network = pattern.slice(0, slash);
  const maskPart = pattern.slice(slash + 1);
  if (!IPAddress.isValid(network)) return false;
  if (!IPAddress.isValid(ip)) return false;
  const prefix = /^\d+$/.test(maskPart)
    ? Number(maskPart)
    : IPAddress.isValid(maskPart) ? prefixFromMask(maskPart) : -1;
  if (prefix < 0 || prefix > 32) return false;
  const shift = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (toUint32(network) & shift) === (toUint32(ip) & shift);
}

function toUint32(ip: string): number {
  return ip.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0) >>> 0;
}

function prefixFromMask(mask: string): number {
  const value = toUint32(mask);
  let bits = 0;
  for (let i = 31; i >= 0; i--) {
    if ((value & (1 << i)) === 0) break;
    bits++;
  }
  return bits;
}

export function clientFor(
  entry: ExportEntry,
  peerIp: string,
  peerHostname: string | null,
): ExportClient | null {
  for (const client of entry.clients) {
    if (client.pattern === '*') return client;
    if (client.pattern === peerIp) return client;
    if (client.pattern.includes('/') && matchesNetwork(client.pattern, peerIp)) return client;
    if (peerHostname && matchesWildcard(client.pattern, peerHostname)) return client;
  }
  return null;
}

export function exportCovering(entries: readonly ExportEntry[], path: string): ExportEntry | null {
  let best: ExportEntry | null = null;
  for (const entry of entries) {
    if (path !== entry.path && !path.startsWith(`${entry.path.replace(/\/+$/, '')}/`)) continue;
    if (!best || entry.path.length > best.path.length) best = entry;
  }
  return best;
}
