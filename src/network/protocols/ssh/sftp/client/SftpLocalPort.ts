import type { SshError } from '../../Result';
import type { EntryType, ISftpFileSystem, SftpFileAttrs } from '../ISftpFileSystem';
import { globPaths, hasMagic, type GlobFileSystem } from '@/network/devices/linux/fs/Glob';

const FILE_BIT = 0o100000;
const DIRECTORY_BIT = 0o040000;
const LINK_BIT = 0o120000;

export function strerrorOf(error: SshError): string {
  if (error.kind === 'PERMISSION_DENIED') return 'Permission denied';
  if (error.kind === 'IO_ERROR') {
    const separator = error.message.lastIndexOf(': ');
    return separator < 0 ? error.message : error.message.slice(separator + 2);
  }
  return 'Failure';
}

export interface LocalStat {
  readonly type: EntryType;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly permissionBits: number;
}

export function typeBitsOf(type: EntryType): number {
  return type === 'directory' ? DIRECTORY_BIT : type === 'symlink' ? LINK_BIT : FILE_BIT;
}

export class SftpLocalPort {
  private currentDirectory: string;
  private currentUmask: number;

  constructor(
    private readonly fs: ISftpFileSystem,
    cwd: string,
    umask: number,
    readonly windowsStyle: boolean,
    readonly home: string,
  ) {
    this.currentDirectory = cwd;
    this.currentUmask = umask;
  }

  get cwd(): string {
    return this.currentDirectory;
  }

  get umask(): number {
    return this.currentUmask;
  }

  setUmask(value: number): void {
    this.currentUmask = value;
  }

  resolve(path: string): string {
    return this.fs.normalizePath(path, this.currentDirectory);
  }

  expandTilde(path: string): string {
    if (path === '~') return this.home;
    if (path.startsWith('~/') || path.startsWith('~\\')) return `${this.home}${path.slice(1)}`;
    return path;
  }

  changeDirectory(path: string): string | null {
    const target = this.resolve(this.expandTilde(path));
    const type = this.fs.getEntryType(target);
    if (type === null) return 'No such file or directory';
    if (type !== 'directory') return 'Not a directory';
    this.currentDirectory = this.windowsStyle ? target.replace(/^\//, '').replace(/\//g, '\\') : target;
    return null;
  }

  stat(path: string): LocalStat | string {
    const attrs = this.fs.stat(this.resolve(path));
    if (attrs.ok === false) return strerrorOf(attrs.error);
    const value: SftpFileAttrs = attrs.value;
    return {
      type: value.type, mode: typeBitsOf(value.type) | (value.mode & 0o7777), size: value.size, mtimeMs: value.mtime,
      permissionBits: value.mode & 0o7777,
    };
  }

  isDirectory(path: string): boolean {
    return this.fs.getEntryType(this.resolve(path)) === 'directory';
  }

  exists(path: string): boolean {
    return this.fs.exists(this.resolve(path));
  }

  read(path: string): { readonly content: string } | { readonly failure: string } {
    const result = this.fs.readFile(this.resolve(path));
    return result.ok === false ? { failure: strerrorOf(result.error) } : { content: result.value };
  }

  write(path: string, content: string, creationMode: number | null): string | null {
    const target = this.resolve(path);
    const existed = this.fs.exists(target);
    const result = this.fs.writeFile(target, content);
    if (result.ok === false) return strerrorOf(result.error);
    if (!existed && creationMode !== null) this.fs.setPermissions(target, creationMode & ~this.currentUmask);
    return null;
  }

  makeDirectory(path: string): string | null {
    const result = this.fs.mkdir(this.resolve(path));
    return result.ok === false ? strerrorOf(result.error) : null;
  }

  setPermissions(path: string, mode: number): string | null {
    const result = this.fs.setPermissions(this.resolve(path), mode);
    return result.ok === false ? strerrorOf(result.error) : null;
  }

  setTimes(path: string, atimeMs: number, mtimeMs: number): string | null {
    if (this.fs.setTimes === undefined) return null;
    const result = this.fs.setTimes(this.resolve(path), { atime: atimeMs, mtime: mtimeMs });
    return result.ok === false ? strerrorOf(result.error) : null;
  }

  listNames(directory: string): readonly string[] | null {
    const result = this.fs.listDirectory(this.resolve(directory));
    return result.ok === false ? null : result.value.map((entry) => entry.name);
  }

  glob(pattern: string, markDirectories: boolean): { readonly paths: string[]; readonly matched: number } {
    const portable = this.windowsStyle ? pattern.replace(/\\/g, '/') : pattern;
    const driveRoot = (base: string): string => (this.windowsStyle && /^[A-Za-z]:$/.test(base) ? `${base}/` : base);
    const view: GlobFileSystem = {
      listNames: (directory) => this.listNames(directory === '' ? '.' : driveRoot(directory)),
      existsNoFollow: (path) => this.exists(driveRoot(path)),
      isDirectory: (path) => this.isDirectory(driveRoot(path)),
    };
    let found = hasMagic(portable)
      ? globPaths(view, portable)
      : (this.exists(portable) ? [portable] : []);
    const matched = found.length;
    if (matched === 0) found = [pattern];
    else if (this.windowsStyle) found = found.map((path) => path.replace(/\//g, '\\'));
    if (markDirectories && matched > 0) {
      found = found.map((path) => (!path.endsWith('/') && !path.endsWith('\\') && this.isDirectory(path)
        ? `${path}${this.windowsStyle ? '\\' : '/'}` : path));
    }
    return { paths: found, matched };
  }
}

