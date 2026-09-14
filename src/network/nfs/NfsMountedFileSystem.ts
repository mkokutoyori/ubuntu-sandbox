import type { IPAddress } from '@/network/core/types';
import type { RemoteMountPort, RemoteMountStat } from '@/network/devices/linux/VirtualFileSystem';
import type { FileType } from '@/network/devices/linux/VirtualFileSystem';
import { Ftype3, NfsStatus } from './wire/NfsConstants';
import type { NfsClient } from './NfsClient';
import type { Fattr3, NfsFileHandle } from './wire/NfsTypes';

const FILE_TYPE_OF: Readonly<Partial<Record<Ftype3, FileType>>> = {
  [Ftype3.NF3REG]: 'file',
  [Ftype3.NF3DIR]: 'directory',
  [Ftype3.NF3LNK]: 'symlink',
  [Ftype3.NF3FIFO]: 'fifo',
  [Ftype3.NF3CHR]: 'chardev',
};

export interface NfsMountBinding {
  readonly mountPoint: string;
  readonly server: IPAddress;
  readonly exportPath: string;
  readonly rootHandle: NfsFileHandle;
  readonly readOnly: boolean;
}

function toLatin1(data: Uint8Array): string {
  let out = '';
  for (const byte of data) out += String.fromCharCode(byte);
  return out;
}

function fromLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function splitTail(path: string): { parent: string; name: string } {
  const trimmed = path.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  return { parent: cut <= 0 ? '/' : trimmed.slice(0, cut), name: trimmed.slice(cut + 1) };
}

export class NfsMountedFileSystem implements RemoteMountPort {
  private readonly bindings: NfsMountBinding[] = [];

  constructor(private readonly client: NfsClient) {}

  attach(binding: NfsMountBinding): void {
    this.detach(binding.mountPoint);
    this.bindings.push(binding);
  }

  detach(mountPoint: string): void {
    const index = this.bindings.findIndex((b) => b.mountPoint === mountPoint);
    if (index >= 0) this.bindings.splice(index, 1);
  }

  get mountCount(): number {
    return this.bindings.length;
  }

  private bindingFor(path: string): NfsMountBinding | null {
    let best: NfsMountBinding | null = null;
    for (const binding of this.bindings) {
      const root = binding.mountPoint.replace(/\/+$/, '');
      if (path !== root && !path.startsWith(`${root}/`)) continue;
      if (!best || root.length > best.mountPoint.replace(/\/+$/, '').length) best = binding;
    }
    return best;
  }

  private relativeOf(binding: NfsMountBinding, path: string): string {
    const root = binding.mountPoint.replace(/\/+$/, '');
    return path === root ? '' : path.slice(root.length + 1);
  }

  private handleOf(path: string): { binding: NfsMountBinding; handle: NfsFileHandle } | null {
    const binding = this.bindingFor(path);
    if (!binding) return null;
    const resolved = this.client.resolvePath(
      binding.server, binding.rootHandle, this.relativeOf(binding, path));
    return resolved instanceof Uint8Array ? { binding, handle: resolved } : null;
  }

  covers(path: string): boolean {
    return this.bindingFor(path) !== null;
  }

  private statOf(attributes: Fattr3): RemoteMountStat {
    return {
      type: FILE_TYPE_OF[attributes.type] ?? 'file',
      permissions: attributes.mode,
      uid: attributes.uid,
      gid: attributes.gid,
      size: Number(attributes.size),
      nlink: attributes.nlink,
      fileid: Number(attributes.fileid),
      atime: attributes.atime.seconds * 1000,
      mtime: attributes.mtime.seconds * 1000,
      ctime: attributes.ctime.seconds * 1000,
    };
  }

  stat(path: string): RemoteMountStat | null {
    const found = this.handleOf(path);
    if (!found) return null;
    const attributes = this.client.getAttr(found.binding.server, found.handle);
    return attributes ? this.statOf(attributes) : null;
  }

  read(path: string): string | null {
    const found = this.handleOf(path);
    if (!found) return null;
    const attributes = this.client.getAttr(found.binding.server, found.handle);
    if (!attributes) return null;
    const data = this.client.read(found.binding.server, found.handle, Number(attributes.size));
    return data instanceof Uint8Array ? toLatin1(data) : null;
  }

  write(path: string, content: string, uid: number, gid: number): boolean {
    const binding = this.bindingFor(path);
    if (!binding || binding.readOnly) return false;
    let target = this.handleOf(path);
    if (!target) {
      const { parent, name } = splitTail(path);
      const parentHandle = this.handleOf(parent);
      if (!parentHandle) return false;
      const created = this.client.create(binding.server, parentHandle.handle, name, 0o644 & ~0o022);
      if (!(created instanceof Uint8Array)) return false;
      target = { binding, handle: created };
    }
    void uid;
    void gid;
    return this.client.write(binding.server, target.handle, fromLatin1(content))
      === NfsStatus.NFS3_OK;
  }

  remove(path: string): boolean {
    const binding = this.bindingFor(path);
    if (!binding || binding.readOnly) return false;
    const { parent, name } = splitTail(path);
    const parentHandle = this.handleOf(parent);
    if (!parentHandle) return false;
    const stat = this.stat(path);
    const status = stat?.type === 'directory'
      ? this.client.removeDirectory(binding.server, parentHandle.handle, name)
      : this.client.remove(binding.server, parentHandle.handle, name);
    return status === NfsStatus.NFS3_OK;
  }

  makeDirectory(path: string, permissions: number, uid: number, gid: number): boolean {
    const binding = this.bindingFor(path);
    if (!binding || binding.readOnly) return false;
    const { parent, name } = splitTail(path);
    const parentHandle = this.handleOf(parent);
    if (!parentHandle) return false;
    void uid;
    void gid;
    return this.client.mkdir(binding.server, parentHandle.handle, name, permissions)
      instanceof Uint8Array;
  }

  list(path: string): readonly string[] | null {
    const found = this.handleOf(path);
    if (!found) return null;
    const entries = this.client.readDir(found.binding.server, found.handle);
    if (!Array.isArray(entries)) return null;
    return entries.map((entry) => entry.name).filter((name) => name !== '.' && name !== '..');
  }

  rename(from: string, to: string): boolean {
    const binding = this.bindingFor(from);
    if (!binding || binding.readOnly) return false;
    const fromTail = splitTail(from);
    const toTail = splitTail(to);
    const fromParent = this.handleOf(fromTail.parent);
    const toParent = this.handleOf(toTail.parent);
    if (!fromParent || !toParent) return false;
    return this.client.rename(
      binding.server, fromParent.handle, fromTail.name, toParent.handle, toTail.name,
    ) === NfsStatus.NFS3_OK;
  }
}
