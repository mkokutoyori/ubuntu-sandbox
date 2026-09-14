import type { INode, VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import {
  ACCESS3_DELETE, ACCESS3_EXECUTE, ACCESS3_EXTEND, ACCESS3_LOOKUP, ACCESS3_MODIFY, ACCESS3_READ,
  Ftype3, NfsStatus,
} from './wire/NfsConstants';
import type {
  NfsCredentials, NfsExportedFileSystem, NfsFileStat, NfsSpaceTotals,
} from './NfsExportedFileSystem';

const HOLE_BYTE = String.fromCharCode(0);

const TYPE_OF: Readonly<Record<INode['type'], Ftype3>> = {
  file: Ftype3.NF3REG,
  directory: Ftype3.NF3DIR,
  symlink: Ftype3.NF3LNK,
  fifo: Ftype3.NF3FIFO,
  chardev: Ftype3.NF3CHR,
};

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

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  return cut <= 0 ? '/' : trimmed.slice(0, cut);
}

function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

function permits(inode: INode, who: NfsCredentials, bits: number): boolean {
  if (who.uid === 0) return true;
  const owns = inode.uid === who.uid;
  const grouped = inode.gid === who.gid || who.gids.includes(inode.gid);
  const shift = owns ? 6 : grouped ? 3 : 0;
  return ((inode.permissions >> shift) & bits) === bits;
}

export class VfsExportedFileSystem implements NfsExportedFileSystem {
  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly umask = 0o022,
  ) {}

  private inode(path: string): INode | null {
    return this.vfs.resolveInode(path, false);
  }

  statPath(path: string): NfsFileStat | null {
    const inode = this.inode(path);
    if (!inode) return null;
    return {
      type: TYPE_OF[inode.type],
      mode: inode.permissions,
      nlink: inode.linkCount,
      uid: inode.uid,
      gid: inode.gid,
      size: inode.type === 'directory' ? 4096 : inode.size,
      fileid: inode.id,
      atime: new Date(inode.atime),
      mtime: new Date(inode.mtime),
      ctime: new Date(inode.ctime),
    };
  }

  readFile(path: string, offset: number, count: number): Uint8Array | null {
    const content = this.vfs.readFile(path);
    if (content === null) return null;
    return fromLatin1(content.slice(offset, offset + count));
  }

  writeFile(path: string, offset: number, data: Uint8Array, who: NfsCredentials): NfsStatus {
    if (!this.vfs.exists(path)) return NfsStatus.NFS3ERR_NOENT;
    const current = this.vfs.readFile(path) ?? '';
    const padded = current.length >= offset
      ? current
      : current + HOLE_BYTE.repeat(offset - current.length);
    const incoming = toLatin1(data);
    const next = padded.slice(0, offset) + incoming + padded.slice(offset + incoming.length);
    if (next.length - current.length > this.vfs.freeBytes()) return NfsStatus.NFS3ERR_NOSPC;
    return this.vfs.writeFile(path, next, who.uid, who.gid, this.umask)
      ? NfsStatus.NFS3_OK
      : NfsStatus.NFS3ERR_ACCES;
  }

  truncateFile(path: string, size: number, who: NfsCredentials): NfsStatus {
    const content = this.vfs.readFile(path);
    if (content === null) return NfsStatus.NFS3ERR_NOENT;
    const next = content.length > size
      ? content.slice(0, size)
      : content + HOLE_BYTE.repeat(size - content.length);
    return this.vfs.writeFile(path, next, who.uid, who.gid, this.umask)
      ? NfsStatus.NFS3_OK
      : NfsStatus.NFS3ERR_ACCES;
  }

  createFile(path: string, mode: number, who: NfsCredentials): NfsStatus {
    if (!this.vfs.exists(parentOf(path))) return NfsStatus.NFS3ERR_NOENT;
    if (!this.vfs.writeFile(path, '', who.uid, who.gid, this.umask, false, undefined, false)) {
      return NfsStatus.NFS3ERR_ACCES;
    }
    this.vfs.chmod(path, mode);
    return NfsStatus.NFS3_OK;
  }

  makeDirectory(path: string, mode: number, who: NfsCredentials): NfsStatus {
    if (!this.vfs.exists(parentOf(path))) return NfsStatus.NFS3ERR_NOENT;
    return this.vfs.mkdir(path, mode, who.uid, who.gid)
      ? NfsStatus.NFS3_OK
      : NfsStatus.NFS3ERR_ACCES;
  }

  removeFile(path: string, who: NfsCredentials): NfsStatus {
    const parent = this.inode(parentOf(path));
    if (!parent) return NfsStatus.NFS3ERR_NOENT;
    if (!permits(parent, who, 0b011)) return NfsStatus.NFS3ERR_ACCES;
    return this.vfs.deleteFile(path) ? NfsStatus.NFS3_OK : NfsStatus.NFS3ERR_ACCES;
  }

  removeDirectory(path: string, who: NfsCredentials): NfsStatus {
    const inode = this.inode(path);
    if (!inode) return NfsStatus.NFS3ERR_NOENT;
    if (inode.children.size > 2) return NfsStatus.NFS3ERR_NOTEMPTY;
    const parent = this.inode(parentOf(path));
    if (!parent || !permits(parent, who, 0b011)) return NfsStatus.NFS3ERR_ACCES;
    return this.vfs.deleteFile(path) ? NfsStatus.NFS3_OK : NfsStatus.NFS3ERR_ACCES;
  }

  renamePath(from: string, to: string, who: NfsCredentials): NfsStatus {
    const parent = this.inode(parentOf(from));
    if (!parent) return NfsStatus.NFS3ERR_NOENT;
    if (!permits(parent, who, 0b011)) return NfsStatus.NFS3ERR_ACCES;
    return this.vfs.rename(from, to) ? NfsStatus.NFS3_OK : NfsStatus.NFS3ERR_NOENT;
  }

  listDirectory(path: string): readonly string[] | null {
    const entries = this.vfs.listDirectory(path);
    if (!entries) return null;
    return entries
      .map((entry) => (typeof entry === 'string' ? entry : entry.name))
      .filter((name) => name !== '.' && name !== '..');
  }

  readSymlink(path: string): string | null {
    const inode = this.inode(path);
    return inode?.type === 'symlink' ? inode.target : null;
  }

  createSymlink(path: string, target: string, who: NfsCredentials): NfsStatus {
    const parent = this.inode(parentOf(path));
    if (!parent) return NfsStatus.NFS3ERR_NOENT;
    if (!permits(parent, who, 0b011)) return NfsStatus.NFS3ERR_ACCES;
    return this.vfs.createSymlink(path, target, who.uid, who.gid)
      ? NfsStatus.NFS3_OK
      : NfsStatus.NFS3ERR_ACCES;
  }

  setAttributes(
    path: string,
    changes: { mode?: number; uid?: number; gid?: number; atime?: Date; mtime?: Date },
    who: NfsCredentials,
  ): NfsStatus {
    const inode = this.inode(path);
    if (!inode) return NfsStatus.NFS3ERR_NOENT;
    if (who.uid !== 0 && inode.uid !== who.uid) return NfsStatus.NFS3ERR_PERM;
    if (changes.mode !== undefined) this.vfs.chmod(path, changes.mode);
    if (changes.uid !== undefined) this.vfs.chown(path, changes.uid, changes.gid);
    else if (changes.gid !== undefined) this.vfs.chown(path, inode.uid, changes.gid);
    if (changes.atime) inode.atime = changes.atime.getTime();
    if (changes.mtime) inode.mtime = changes.mtime.getTime();
    return NfsStatus.NFS3_OK;
  }

  accessMask(path: string, who: NfsCredentials): number {
    const inode = this.inode(path);
    if (!inode) return 0;
    let mask = 0;
    if (permits(inode, who, 0b100)) {
      mask |= inode.type === 'directory' ? ACCESS3_READ | ACCESS3_LOOKUP : ACCESS3_READ;
    }
    if (permits(inode, who, 0b010)) {
      mask |= inode.type === 'directory'
        ? ACCESS3_MODIFY | ACCESS3_EXTEND | ACCESS3_DELETE
        : ACCESS3_MODIFY | ACCESS3_EXTEND;
    }
    if (permits(inode, who, 0b001)) {
      mask |= inode.type === 'directory' ? ACCESS3_LOOKUP : ACCESS3_EXECUTE;
    }
    return mask;
  }

  spaceTotals(): NfsSpaceTotals {
    return {
      totalBytes: this.vfs.getCapacityBytes(),
      freeBytes: this.vfs.freeBytes(),
      totalFiles: this.vfs.getInodeCapacity(),
      freeFiles: Math.max(0, this.vfs.getInodeCapacity() - this.vfs.getInodeCount()),
    };
  }

  isReadOnly(path: string): boolean {
    return this.vfs.isReadOnly(path) || (this.inode(path)?.immutable ?? false);
  }
}

export { basenameOf as nfsBasename, parentOf as nfsParent };
