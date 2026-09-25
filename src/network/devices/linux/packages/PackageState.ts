import type { VirtualFileSystem } from '../VirtualFileSystem';
import { PACKAGE_DB, type InstalledPackage, type PackageEntry } from './PackageDatabase';

export const DPKG_STATUS_PATH = '/var/lib/dpkg/status';
const DPKG_STATE_DIR = '/var/lib/dpkg';

export type DpkgState = 'installed' | 'config-files';

export interface DpkgRecord {
  readonly entry: PackageEntry;
  readonly state: DpkgState;
}

export interface PackageStateHost {
  readonly vfs: VirtualFileSystem;
  readonly serviceMgr: { hasUnitFile(name: string): boolean };
}

const STATUS_FIELD: Readonly<Record<DpkgState, string>> = {
  installed: 'install ok installed',
  'config-files': 'deinstall ok config-files',
};

function shippedByImage(host: PackageStateHost, entry: InstalledPackage): boolean {
  const units = entry.units ?? [];
  const files = entry.files ?? [];
  if (units.length === 0 && files.length === 0) return entry.installed;
  return units.every((unit) => host.serviceMgr.hasUnitFile(unit))
    && files.every((file) => host.vfs.exists(file));
}

function renderStatus(records: readonly DpkgRecord[]): string {
  return records.map(({ entry, state }) => [
    `Package: ${entry.name}`,
    `Status: ${STATUS_FIELD[state]}`,
    `Architecture: ${entry.arch}`,
    `Version: ${entry.version}`,
    `Description: ${entry.summary}`,
    '',
  ].join('\n')).join('\n');
}

function parseStatus(text: string): Map<string, DpkgState> {
  const states = new Map<string, DpkgState>();
  for (const stanza of text.split(/\n\s*\n/)) {
    const name = /^Package:\s*(\S+)/m.exec(stanza)?.[1];
    const status = /^Status:\s*(.+)$/m.exec(stanza)?.[1]?.trim();
    if (!name || !status) continue;
    if (status === STATUS_FIELD.installed) states.set(name, 'installed');
    else if (status === STATUS_FIELD['config-files']) states.set(name, 'config-files');
  }
  return states;
}

function writeStatus(host: PackageStateHost, records: readonly DpkgRecord[]): void {
  if (!host.vfs.exists(DPKG_STATE_DIR)) host.vfs.mkdirp(DPKG_STATE_DIR, 0o755, 0, 0);
  host.vfs.writeFile(DPKG_STATUS_PATH, renderStatus(records), 0, 0, 0o022);
}

export function packageRecords(host: PackageStateHost): DpkgRecord[] {
  const text = host.vfs.readFile(DPKG_STATUS_PATH);
  if (text == null) {
    const seeded = PACKAGE_DB
      .filter((entry) => shippedByImage(host, entry))
      .map((entry): DpkgRecord => ({ entry, state: 'installed' }));
    writeStatus(host, seeded);
    return seeded;
  }
  const states = parseStatus(text);
  return PACKAGE_DB
    .filter((entry) => states.has(entry.name))
    .map((entry) => ({ entry, state: states.get(entry.name)! }));
}

export function packageStateOf(host: PackageStateHost, name: string): DpkgState | undefined {
  return packageRecords(host).find((record) => record.entry.name === name)?.state;
}

export function recordPackageState(
  host: PackageStateHost, entry: PackageEntry, state: DpkgState | undefined,
): void {
  const others = packageRecords(host).filter((record) => record.entry.name !== entry.name);
  const records = state === undefined ? others : [...others, { entry, state }];
  const order = new Map(PACKAGE_DB.map((known, index) => [known.name, index]));
  records.sort((a, b) => (order.get(a.entry.name) ?? 0) - (order.get(b.entry.name) ?? 0));
  writeStatus(host, records);
}
