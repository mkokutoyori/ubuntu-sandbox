import type { ExportClient, ExportEntry } from '@/network/nfs/ExportTable';
import type { MountEntryRecord } from '@/network/nfs/wire/NfsTypes';

export interface ExportfsOutcome {
  readonly output: string;
  readonly exitCode: number;
}

function optionText(client: ExportClient): string {
  const flags = [
    client.sync ? 'sync' : 'async',
    'wdelay',
    'hide',
    client.subtreeCheck ? 'subtree_check' : 'no_subtree_check',
    'sec=sys',
    client.readOnly ? 'ro' : 'rw',
    client.secure ? 'secure' : 'insecure',
    client.rootSquash ? 'root_squash' : 'no_root_squash',
    client.allSquash ? 'all_squash' : 'no_all_squash',
  ];
  return flags.join(',');
}

function padPath(path: string): string {
  return path.length >= 14 ? `${path}\t` : path.padEnd(14) + '\t';
}

export function renderExportList(entries: readonly ExportEntry[], verbose: boolean): string {
  const lines: string[] = [];
  for (const entry of entries) {
    for (const client of entry.clients) {
      lines.push(verbose
        ? `${padPath(entry.path)}${client.pattern}(${optionText(client)})`
        : `${padPath(entry.path)}${client.pattern}`);
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

export function renderExportsSource(entries: readonly ExportEntry[]): string {
  const lines = entries.map((entry) => {
    const clients = entry.clients
      .map((client) => `${client.pattern}(${optionText(client)})`)
      .join(' ');
    return `${entry.path}\t${clients}`;
  });
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

export function renderShowmountExports(host: string, entries: readonly ExportEntry[]): string {
  const rows = entries.map((entry) => {
    const patterns = entry.clients.map((client) => client.pattern).join(',');
    return `${entry.path} ${patterns}`;
  });
  return [`Export list for ${host}:`, ...rows].join('\n') + '\n';
}

export function renderShowmountMounts(host: string, mounts: readonly MountEntryRecord[]): string {
  const rows = mounts.map((mount) => `${mount.hostname}:${mount.directory}`).sort();
  return [`All mount points on ${host}:`, ...rows].join('\n') + '\n';
}

export function renderShowmountDirectories(
  host: string, mounts: readonly MountEntryRecord[],
): string {
  const rows = [...new Set(mounts.map((mount) => mount.directory))].sort();
  return [`Directories on ${host}:`, ...rows].join('\n') + '\n';
}

export function renderShowmountHosts(host: string, mounts: readonly MountEntryRecord[]): string {
  const rows = [...new Set(mounts.map((mount) => mount.hostname))].sort();
  return [`Hosts on ${host}:`, ...rows].join('\n') + '\n';
}
