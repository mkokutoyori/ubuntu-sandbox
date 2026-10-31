import type { WinACE, WinAuditACE, WinFSEntry, WinFileType } from './WindowsFileSystem';

export interface RemoteNode {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly modified: number;
  readonly created: number;
  readonly attributes: readonly string[];
}

export interface RemoteVolumeInformation {
  readonly label: string;
  readonly serial: string;
  readonly capacity: number;
  readonly free: number;
}

export interface RemoteVolume {
  readonly remote: string;
  stat(path: string): { ok: boolean; node?: RemoteNode; canonical?: string; error?: string };
  list(path: string): { ok: boolean; entries?: RemoteNode[]; error?: string };
  read(path: string): { ok: boolean; content?: string; error?: string };
  write(path: string, content: string): { ok: boolean; error?: string };
  mkdir(path: string): { ok: boolean; error?: string };
  remove(path: string): { ok: boolean; error?: string };
  removeDirectory(path: string): { ok: boolean; error?: string };
  rename(path: string, target: string, replace?: boolean): { ok: boolean; error?: string };
  setAttributes(path: string, attributes: string[]): { ok: boolean; error?: string };
  setModified(path: string, modified: number): { ok: boolean; error?: string };
  volumeInfo(): { ok: boolean; volume?: RemoteVolumeInformation; error?: string };
}

export interface RemoteVolumes {
  volumeAt(letter: string): RemoteVolume | null;
  letters(): string[];
}

export class RemoteVolumeError extends Error {}

const unsupported = (what: string): RemoteVolumeError =>
  new RemoteVolumeError(`${what} of a file on a network drive is not carried by the redirector.`);

class RemoteAttributes extends Set<string> {
  constructor(initial: readonly string[], private readonly store: (names: string[]) => void) {
    super();
    for (const name of initial) super.add(name);
  }

  override add(name: string): this {
    if (!this.has(name)) {
      this.store([...this, name]);
      super.add(name);
    }
    return this;
  }

  override delete(name: string): boolean {
    if (!this.has(name)) return false;
    this.store([...this].filter(held => held !== name));
    return super.delete(name);
  }

  override clear(): void {
    if (this.size === 0) return;
    this.store([]);
    super.clear();
  }
}

export class RemoteEntry implements WinFSEntry {
  readonly name: string;
  readonly type: WinFileType;
  readonly ctime: Date;
  size: number;
  private modified: Date;
  private held: RemoteAttributes;
  private text: string | null = null;

  constructor(
    private readonly volume: RemoteVolume,
    private readonly path: string,
    node: RemoteNode,
    label?: string,
  ) {
    this.name = label ?? node.name;
    this.type = node.isDirectory ? 'directory' : 'file';
    this.size = node.size;
    this.modified = new Date(node.modified);
    this.ctime = new Date(node.created);
    this.held = new RemoteAttributes(node.attributes, names => this.change(this.volume.setAttributes(this.path, names)));
  }

  private change(outcome: { ok: boolean; error?: string }): void {
    if (!outcome.ok) throw new RemoteVolumeError(outcome.error ?? 'Access is denied.');
  }

  get content(): string {
    if (this.text === null) {
      const read = this.volume.read(this.path);
      if (!read.ok) throw new RemoteVolumeError(read.error ?? 'Access is denied.');
      this.text = read.content ?? '';
      this.size = this.text.length;
    }
    return this.text;
  }

  set content(value: string) {
    this.change(this.volume.write(this.path, value));
    this.text = value;
    this.size = value.length;
  }

  get children(): Map<string, WinFSEntry> {
    const listing = this.type === 'directory' ? this.volume.list(this.path) : { ok: false, entries: undefined };
    const children = new Map<string, WinFSEntry>();
    for (const node of listing.entries ?? []) {
      const childPath = this.path === '' ? node.name : `${this.path}\\${node.name}`;
      children.set(node.name.toLowerCase(), new RemoteEntry(this.volume, childPath, node));
    }
    return children;
  }

  get mtime(): Date {
    return this.modified;
  }

  set mtime(value: Date) {
    this.change(this.volume.setModified(this.path, value.getTime()));
    this.modified = new Date(value);
  }

  get attributes(): Set<string> {
    return this.held;
  }

  set attributes(value: Set<string>) {
    const names = [...value];
    this.change(this.volume.setAttributes(this.path, names));
    this.held = new RemoteAttributes(names, stored => this.change(this.volume.setAttributes(this.path, stored)));
  }

  get owner(): string {
    return '';
  }

  set owner(_value: string) {
    throw unsupported('The owner');
  }

  get acl(): WinACE[] {
    return [];
  }

  set acl(_value: WinACE[]) {
    throw unsupported('The access control list');
  }

  get aclProtected(): boolean | undefined {
    return undefined;
  }

  set aclProtected(_value: boolean | undefined) {
    throw unsupported('The inheritance of the access control list');
  }

  get sacl(): WinAuditACE[] | undefined {
    return undefined;
  }

  set sacl(_value: WinAuditACE[] | undefined) {
    throw unsupported('The audit list');
  }
}
