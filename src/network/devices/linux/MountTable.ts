import type { StorageDevice } from '../host/hardware';

export interface MountEntryInit {
  source: string;
  target: string;
  fstype: string;
  options?: Iterable<string>;
  bindOrigin?: string;
}

const OPTION_ORDER = [
  'rw', 'ro', 'nosuid', 'nodev', 'noexec', 'relatime', 'noatime',
  'errors=remount-ro', 'bind',
];

export class MountEntry {
  source: string;
  target: string;
  fstype: string;
  readonly options: Set<string>;
  bindOrigin?: string;

  constructor(init: MountEntryInit) {
    this.source = init.source;
    this.target = normalizeTarget(init.target);
    this.fstype = init.fstype;
    this.options = new Set(init.options ?? ['rw', 'relatime']);
    if (!this.options.has('ro') && !this.options.has('rw')) this.options.add('rw');
    this.bindOrigin = init.bindOrigin;
  }

  get readOnly(): boolean {
    return this.options.has('ro');
  }

  get isBind(): boolean {
    return this.bindOrigin !== undefined;
  }

  setReadOnly(ro: boolean): void {
    this.options.delete('ro');
    this.options.delete('rw');
    this.options.add(ro ? 'ro' : 'rw');
  }

  mergeOptions(opts: Iterable<string>): void {
    for (const raw of opts) {
      const opt = raw.trim();
      if (!opt || opt === 'remount' || opt === 'bind') continue;
      if (opt === 'ro') { this.setReadOnly(true); continue; }
      if (opt === 'rw') { this.setReadOnly(false); continue; }
      this.options.add(opt);
    }
  }

  optionString(): string {
    const present = [...this.options];
    const ordered = OPTION_ORDER.filter((o) => this.options.has(o));
    const rest = present.filter((o) => !OPTION_ORDER.includes(o)).sort();
    return [...ordered, ...rest].join(',');
  }
}

export class MountTable {
  private entries: MountEntry[] = [];

  constructor(entries: MountEntry[] = []) {
    for (const e of entries) this.entries.push(e);
  }

  static fromHardware(storage: StorageDevice[]): MountTable {
    const table = new MountTable();
    table.addPseudo();
    for (const disk of storage) {
      for (const part of disk.partitions) {
        if (!part.mountPoint) continue;
        const opts = part.mountPoint === '/'
          ? ['rw', 'relatime', 'errors=remount-ro']
          : ['rw', 'relatime'];
        table.entries.push(new MountEntry({
          source: `/dev/${part.name}`,
          target: part.mountPoint,
          fstype: part.fsType || 'ext4',
          options: opts,
        }));
      }
    }
    table.sort();
    return table;
  }

  private addPseudo(): void {
    this.entries.push(
      new MountEntry({ source: 'proc', target: '/proc', fstype: 'proc', options: ['rw', 'nosuid', 'nodev', 'noexec', 'relatime'] }),
      new MountEntry({ source: 'sysfs', target: '/sys', fstype: 'sysfs', options: ['rw', 'nosuid', 'nodev', 'noexec', 'relatime'] }),
      new MountEntry({ source: 'udev', target: '/dev', fstype: 'devtmpfs', options: ['rw', 'nosuid', 'relatime'] }),
      new MountEntry({ source: 'tmpfs', target: '/dev/shm', fstype: 'tmpfs', options: ['rw', 'nosuid', 'nodev'] }),
      new MountEntry({ source: 'tmpfs', target: '/run/lock', fstype: 'tmpfs', options: ['rw', 'nosuid', 'nodev', 'noexec', 'relatime', 'size=5120k'] }),
    );
  }

  list(): MountEntry[] {
    return [...this.entries];
  }

  has(target: string): boolean {
    const t = normalizeTarget(target);
    return this.entries.some((e) => e.target === t);
  }

  find(target: string): MountEntry | undefined {
    const t = normalizeTarget(target);
    return this.entries.find((e) => e.target === t);
  }

  resolve(path: string): MountEntry | undefined {
    const p = normalizeTarget(path);
    let best: MountEntry | undefined;
    for (const e of this.entries) {
      if (e.target === p || p === e.target || isUnder(p, e.target)) {
        if (!best || e.target.length > best.target.length) best = e;
      }
    }
    return best;
  }

  isReadOnly(path: string): boolean {
    return this.resolve(path)?.readOnly ?? false;
  }

  mount(entry: MountEntry): MountEntry {
    const existing = this.find(entry.target);
    if (existing) {
      existing.source = entry.source;
      existing.fstype = entry.fstype;
      existing.options.clear();
      for (const o of entry.options) existing.options.add(o);
      existing.bindOrigin = entry.bindOrigin;
      this.sort();
      return existing;
    }
    this.entries.push(entry);
    this.sort();
    return entry;
  }

  bind(source: string, target: string, options: Iterable<string> = []): MountEntry {
    const origin = normalizeTarget(source);
    const originMount = this.resolve(origin);
    const entry = new MountEntry({
      source: origin,
      target,
      fstype: originMount?.fstype ?? 'none',
      options: ['rw', 'relatime', ...options],
      bindOrigin: origin,
    });
    return this.mount(entry);
  }

  remount(target: string, options: Iterable<string>): MountEntry {
    const opts = [...options];
    const existing = this.find(target);
    if (existing) {
      existing.mergeOptions(opts);
      return existing;
    }
    const parent = this.resolve(target);
    const entry = new MountEntry({
      source: parent?.source ?? normalizeTarget(target),
      target,
      fstype: parent?.fstype ?? 'ext4',
      options: parent ? [...parent.options] : ['rw', 'relatime'],
    });
    entry.mergeOptions(opts);
    return this.mount(entry);
  }

  umount(target: string): boolean {
    const t = normalizeTarget(target);
    const idx = this.entries.findIndex((e) => e.target === t);
    if (idx < 0) return false;
    this.entries.splice(idx, 1);
    return true;
  }

  private sort(): void {
    this.entries.sort((a, b) => a.target.localeCompare(b.target));
  }

  toMountOutput(filterType?: string): string {
    return this.entries
      .filter((e) => !filterType || e.fstype === filterType)
      .map((e) => `${e.source} on ${e.target} type ${e.fstype} (${e.optionString()})`)
      .join('\n');
  }

  toProcMounts(): string {
    return this.entries
      .map((e) => `${e.source} ${e.target} ${e.fstype} ${e.optionString()} 0 0`)
      .join('\n') + '\n';
  }

  toMountInfo(): string {
    let id = 20;
    return this.entries
      .map((e) => {
        const major = e.fstype === 'tmpfs' || e.fstype === 'proc' || e.fstype === 'sysfs' ? '0' : '8';
        const roRw = e.readOnly ? 'ro' : 'rw';
        return `${id++} 1 ${major}:0 / ${e.target} ${roRw},relatime shared:1 - ${e.fstype} ${e.source} ${e.optionString()}`;
      })
      .join('\n') + '\n';
  }
}

function normalizeTarget(path: string): string {
  if (!path) return '/';
  const collapsed = path.replace(/\/+/g, '/').replace(/\/$/, '');
  return collapsed === '' ? '/' : collapsed;
}

function isUnder(path: string, mountPoint: string): boolean {
  if (mountPoint === '/') return true;
  return path.startsWith(mountPoint + '/');
}
