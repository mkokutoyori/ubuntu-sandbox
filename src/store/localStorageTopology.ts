import type { TopologyExport } from './topologySerializer';

const STORAGE_PREFIX = 'ubuntu-sandbox:topology:';

export interface SavedTopologyEntry {
  name: string;
  savedAt: string;
  deviceCount: number;
  connectionCount: number;
}

function storageKey(name: string): string {
  return `${STORAGE_PREFIX}${name}`;
}

export function saveTopologyToBrowser(name: string, topology: TopologyExport): void {
  if (!name.trim()) throw new Error('Topology name is required');
  localStorage.setItem(storageKey(name), JSON.stringify(topology));
}

export function loadTopologyFromBrowser(name: string): TopologyExport | null {
  const raw = localStorage.getItem(storageKey(name));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TopologyExport;
  } catch {
    return null;
  }
}

export function deleteTopologyFromBrowser(name: string): void {
  localStorage.removeItem(storageKey(name));
}

export function listSavedTopologies(): SavedTopologyEntry[] {
  const entries: SavedTopologyEntry[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
    const name = key.slice(STORAGE_PREFIX.length);
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const t = JSON.parse(raw) as TopologyExport;
      entries.push({
        name,
        savedAt: t.exportedAt,
        deviceCount: t.devices?.length ?? 0,
        connectionCount: t.connections?.length ?? 0,
      });
    } catch {
      continue;
    }
  }
  entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return entries;
}
