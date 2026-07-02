import type { VirtualFileSystem, INode, FileType } from './VirtualFileSystem';

export interface PathActor {
  uid: number;
  gid: number;
  gids?: number[];
  user?: string;
  groupNames?: string[];
}

export class PathError extends Error {
  constructor(
    readonly path: string,
    readonly reason: 'ENOENT' | 'EACCES' | 'ENOTDIR' | 'EISDIR',
    message: string,
  ) {
    super(message);
    this.name = 'PathError';
  }
}

export class VfsPath {
  readonly value: string;

  constructor(
    private readonly vfs: VirtualFileSystem,
    input: string,
    cwd = '/',
    private readonly actor: PathActor = { uid: 0, gid: 0 },
  ) {
    this.value = vfs.normalizePath(input, cwd);
  }

  get basename(): string {
    const slash = this.value.lastIndexOf('/');
    return slash < 0 ? this.value : this.value.slice(slash + 1) || '/';
  }

  get dirname(): string {
    const slash = this.value.lastIndexOf('/');
    if (slash <= 0) return '/';
    return this.value.slice(0, slash);
  }

  parent(): VfsPath {
    return new VfsPath(this.vfs, this.dirname, '/', this.actor);
  }

  join(segment: string): VfsPath {
    return new VfsPath(this.vfs, `${this.value}/${segment}`, '/', this.actor);
  }

  withActor(actor: PathActor): VfsPath {
    return new VfsPath(this.vfs, this.value, '/', actor);
  }

  inode(): INode | null {
    return this.vfs.resolveInode(this.value, true);
  }

  lstatNode(): INode | null {
    return this.vfs.resolveInode(this.value, false);
  }

  exists(): boolean {
    return this.inode() !== null;
  }

  lexists(): boolean {
    return this.lstatNode() !== null;
  }

  type(): FileType | null {
    return this.inode()?.type ?? null;
  }

  isFile(): boolean {
    return this.type() === 'file';
  }

  isDirectory(): boolean {
    return this.type() === 'directory';
  }

  isSymlink(): boolean {
    return this.lstatNode()?.type === 'symlink';
  }

  realpath(requireFinal = true): VfsPath | null {
    const canon = this.vfs.realpath(this.value, '/', requireFinal);
    return canon === null ? null : new VfsPath(this.vfs, canon, '/', this.actor);
  }

  get actorUid(): number {
    return this.actor.uid;
  }

  ownedByActor(): boolean {
    if (this.actor.uid === 0) return true;
    const node = this.inode();
    return !!node && node.uid === this.actor.uid;
  }

  isWritableDir(): boolean {
    const node = this.inode();
    return !!node && node.type === 'directory' && this.canWrite() && this.canExecute();
  }

  canRead(): boolean {
    return this.allows('r');
  }

  canWrite(): boolean {
    return this.allows('w');
  }

  canExecute(): boolean {
    return this.allows('x');
  }

  private allows(mode: 'r' | 'w' | 'x'): boolean {
    const node = this.inode();
    if (!node) return false;
    if (this.actor.uid === 0) return true;
    if (this.actor.user) {
      const bit = mode === 'r' ? 0o4 : mode === 'w' ? 0o2 : 0o1;
      const acl = this.vfs.checkAclAccess(
        this.value, this.actor.user, this.actor.groupNames ?? [], bit,
      );
      if (acl !== null) return acl;
    }
    return this.vfs.checkAccess(node, mode, this.actor.uid, this.actor.gid, this.actor.gids ?? []);
  }

  assertExists(): this {
    if (!this.exists()) {
      throw new PathError(this.value, 'ENOENT', `${this.value}: No such file or directory`);
    }
    return this;
  }

  assertDirectory(): this {
    this.assertExists();
    if (!this.isDirectory()) {
      throw new PathError(this.value, 'ENOTDIR', `${this.value}: Not a directory`);
    }
    return this;
  }

  assertReadable(): this {
    this.assertExists();
    if (!this.canRead()) {
      throw new PathError(this.value, 'EACCES', `${this.value}: Permission denied`);
    }
    return this;
  }

  assertWritable(): this {
    if (this.exists()) {
      if (!this.canWrite()) {
        throw new PathError(this.value, 'EACCES', `${this.value}: Permission denied`);
      }
      return this;
    }
    const parent = this.parent();
    parent.assertDirectory();
    if (!parent.canWrite()) {
      throw new PathError(this.value, 'EACCES', `${this.value}: Permission denied`);
    }
    return this;
  }

  assertExecutable(): this {
    this.assertExists();
    if (!this.canExecute()) {
      throw new PathError(this.value, 'EACCES', `${this.value}: Permission denied`);
    }
    return this;
  }

  toString(): string {
    return this.value;
  }
}
