/**
 * Fichiers de configuration de systemd-networkd.
 *
 * `networkctl status` nommait déjà un `Link File` sans qu'aucun fichier de
 * ce type existe ni soit analysé nulle part. Deux issues honnêtes : rendre
 * le fichier réel, ou cesser de le nommer. On rend le fichier réel
 * (`docs/PRD-networkctl.md` §5), parce que `/etc/systemd/network/*.network`
 * est le mode de configuration natif d'Ubuntu Server.
 *
 * Référence : `systemd.network(5)`, `systemd.link(5)`.
 */

import type { VirtualFileSystem } from '../VirtualFileSystem';

/**
 * Ordre de recherche de systemd : l'administrateur d'abord, le paquet en
 * dernier. À nom de fichier égal, le répertoire le plus prioritaire
 * masque les autres.
 */
export const NETWORKD_DIRS = [
  '/etc/systemd/network',
  '/run/systemd/network',
  '/usr/lib/systemd/network',
] as const;

export interface NetworkdMatch {
  name?: string;
  originalName?: string;
  type?: string;
}

export interface NetworkdFile {
  path: string;
  /** Nom de base, qui décide de l'ordre lexicographique. */
  basename: string;
  kind: 'network' | 'link' | 'netdev';
  match: NetworkdMatch;
  /** Sections analysées, clé insensible à la casse au niveau section. */
  sections: Map<string, Map<string, string[]>>;
  text: string;
}

function parseSections(text: string): Map<string, Map<string, string[]>> {
  const sections = new Map<string, Map<string, string[]>>();
  let current: Map<string, string[]> | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+)]$/.exec(line);
    if (header) {
      const name = header[1].trim();
      current = sections.get(name) ?? new Map<string, string[]>();
      sections.set(name, current);
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    // systemd accumule les occurrences d'une même clé (DNS=, Address=)
    // au lieu de garder la dernière.
    const bucket = current.get(key) ?? [];
    bucket.push(value);
    current.set(key, bucket);
  }
  return sections;
}

export function get(file: NetworkdFile, section: string, key: string): string | undefined {
  return file.sections.get(section)?.get(key)?.[0];
}

export function getAll(file: NetworkdFile, section: string, key: string): string[] {
  return file.sections.get(section)?.get(key) ?? [];
}

function parseFile(path: string, text: string): NetworkdFile | null {
  const dot = path.lastIndexOf('.');
  const ext = dot < 0 ? '' : path.slice(dot + 1);
  if (ext !== 'network' && ext !== 'link' && ext !== 'netdev') return null;
  const sections = parseSections(text);
  const match = sections.get('Match');
  return {
    path,
    basename: path.slice(path.lastIndexOf('/') + 1),
    kind: ext,
    match: {
      name: match?.get('Name')?.[0],
      originalName: match?.get('OriginalName')?.[0],
      type: match?.get('Type')?.[0],
    },
    sections,
    text,
  };
}

/**
 * Tous les fichiers découverts, triés par nom de base — c'est ce tri qui
 * permet à un `10-` de battre un `99-`, et non l'ordre des répertoires.
 */
export function discoverNetworkdFiles(vfs: VirtualFileSystem): NetworkdFile[] {
  const byBasename = new Map<string, NetworkdFile>();
  for (const dir of NETWORKD_DIRS) {
    const entries = vfs.listDirectory(dir);
    if (!entries) continue;
    for (const entry of entries) {
      // Le premier répertoire qui fournit ce nom l'emporte : un fichier
      // d'/etc masque son homonyme d'/usr/lib, comme chez systemd.
      if (byBasename.has(entry.name)) continue;
      const path = `${dir}/${entry.name}`;
      const text = vfs.readFile(path);
      if (text === null) continue;
      const parsed = parseFile(path, text);
      if (parsed) byBasename.set(entry.name, parsed);
    }
  }
  return [...byBasename.values()].sort((a, b) => a.basename.localeCompare(b.basename));
}

function globMatches(pattern: string | undefined, name: string): boolean {
  if (!pattern) return false;
  return pattern.split(/\s+/).some((p) => {
    if (p === '*') return true;
    const rx = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    return rx.test(name);
  });
}

/** Premier `.network` dont le `[Match]` retient l'interface. */
export function matchNetworkFile(files: readonly NetworkdFile[], iface: string): NetworkdFile | null {
  for (const f of files) {
    if (f.kind !== 'network') continue;
    if (!f.match.name) continue;
    if (globMatches(f.match.name, iface)) return f;
  }
  return null;
}

/** Premier `.link` retenu — le `[Match]` y porte `OriginalName`. */
export function matchLinkFile(files: readonly NetworkdFile[], iface: string): NetworkdFile | null {
  for (const f of files) {
    if (f.kind !== 'link') continue;
    if (globMatches(f.match.originalName ?? f.match.name, iface)) return f;
  }
  return null;
}

export const DEFAULT_LINK_FILE_PATH = '/usr/lib/systemd/network/99-default.link';

export const DEFAULT_LINK_FILE_TEXT = [
  '[Match]',
  'OriginalName=*',
  '',
  '[Link]',
  'NamePolicy=keep kernel database onboard slot path',
  'AlternativeNamesPolicy=database onboard slot path',
  'MACAddressPolicy=persistent',
  '',
].join('\n');
