/**
 * Les fichiers `.dnssd` — comment systemd publie un service.
 *
 * `systemd-resolved` ne prend pas de service en ligne de commande : il
 * lit `/etc/systemd/dnssd/*.dnssd`, du même format d'unité que les
 * `.network` de networkd, et annonce ce qu'il y trouve en mDNS
 * (`systemd.dnssd(5)`).
 *
 * ```ini
 * [Service]
 * Name=Mon serveur web
 * Type=_http._tcp
 * Port=80
 * TxtText=path=/index.html
 * ```
 */
import type { VirtualFileSystem } from '../VirtualFileSystem';
import type { ServiceRegistration } from '@/network/dnssd/types';

/** Même ordre de recherche que networkd : l'administrateur d'abord. */
export const DNSSD_DIRS = [
  '/etc/systemd/dnssd',
  '/run/systemd/dnssd',
  '/usr/lib/systemd/dnssd',
] as const;

export interface DnssdFile {
  path: string;
  basename: string;
  service: ServiceRegistration;
}

function parseSections(text: string): Map<string, Map<string, string[]>> {
  const sections = new Map<string, Map<string, string[]>>();
  let current: Map<string, string[]> | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+)]$/.exec(line);
    if (header) {
      const key = header[1].trim().toLowerCase();
      current = sections.get(key) ?? new Map<string, string[]>();
      sections.set(key, current);
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    const bucket = current.get(key) ?? [];
    // Une clé répétée s'accumule — c'est ainsi qu'un service porte
    // plusieurs segments TXT.
    bucket.push(value);
    current.set(key, bucket);
  }
  return sections;
}

/** Rend null pour un fichier sans `[Service]` exploitable. */
export function parseDnssdFile(path: string, text: string): DnssdFile | null {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  if (!basename.endsWith('.dnssd')) return null;
  const service = parseSections(text).get('service');
  if (!service) return null;

  const name = service.get('name')?.[0];
  const type = service.get('type')?.[0];
  const port = Number.parseInt(service.get('port')?.[0] ?? '', 10);
  // Sans l'un des trois, l'unité ne décrit aucun service joignable :
  // la charger à moitié publierait une annonce trompeuse.
  if (!name || !type || !Number.isFinite(port)) return null;

  return {
    path,
    basename,
    service: {
      instance: name,
      type: type.toLowerCase(),
      port,
      txt: service.get('txttext') ?? [],
    },
  };
}

/**
 * Tous les services déclarés, à nom de base unique — un fichier d'`/etc`
 * masque son homonyme d'`/usr/lib`, comme chez systemd.
 */
export function discoverDnssdFiles(vfs: VirtualFileSystem): DnssdFile[] {
  const byBasename = new Map<string, DnssdFile>();
  for (const dir of DNSSD_DIRS) {
    const entries = vfs.listDirectory(dir);
    if (!entries) continue;
    for (const entry of entries) {
      if (byBasename.has(entry.name)) continue;
      const path = `${dir}/${entry.name}`;
      const text = vfs.readFile(path);
      if (text === null) continue;
      const parsed = parseDnssdFile(path, text);
      if (parsed) byBasename.set(entry.name, parsed);
    }
  }
  return [...byBasename.values()].sort((a, b) => a.basename.localeCompare(b.basename));
}
