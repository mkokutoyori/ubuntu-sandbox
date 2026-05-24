/**
 * RouterSftpFileSystem — minimal ISftpFileSystem adapter exposing the
 * synthetic files Cisco IOS / Huawei VRP make available to scp / sftp
 * sessions (running-config, startup-config, vlan.dat, …).
 *
 * Real IOS exposes its `flash:` / system files over the SSH transport
 * when `ip scp server enable` is set; this adapter mirrors that surface
 * so the cross-vendor scp client can pull `running-config` from a
 * router exactly like a real one.
 */

import type {
  ISftpFileSystem, SftpDirEntry, SftpFileAttrs, EntryType,
} from './ISftpFileSystem';
import { ok, err, type Result, type SshError } from '../Result';

export interface RouterSftpSource {
  /** Synthesised file blob, or null if the file does not exist. */
  read(path: string): string | null;
  /** Synthesised write back into the device (for `copy tftp running-config`). */
  write?(path: string, content: string): boolean;
  /** Optional file listing for directory operations. */
  list?(): readonly string[];
}

export class RouterSftpFileSystem implements ISftpFileSystem {
  constructor(private readonly source: RouterSftpSource) {}

  private canonical(path: string): string {
    return path.replace(/^\/+/, '').replace(/\\/g, '/').toLowerCase();
  }

  normalizePath(path: string, _cwd: string): string {
    return path;
  }
  exists(path: string): boolean {
    return this.source.read(this.canonical(path)) !== null;
  }
  getEntryType(path: string): EntryType | null {
    return this.source.read(this.canonical(path)) === null ? null : 'file';
  }
  readFile(path: string): Result<string> {
    const data = this.source.read(this.canonical(path));
    return data === null
      ? err({ kind: 'IO_ERROR', message: `${path}: No such file or directory` } as SshError)
      : ok(data);
  }
  listDirectory(_path: string): Result<readonly SftpDirEntry[]> {
    const names = this.source.list?.() ?? [];
    return ok(names.map(n => ({
      name: n, type: 'file' as EntryType, mode: 0o644, uid: 0, gid: 0, size: 0, mtime: Date.now(),
    })));
  }
  stat(path: string): Result<SftpFileAttrs> {
    const data = this.source.read(this.canonical(path));
    if (data === null) return err({ kind: 'IO_ERROR', message: `${path}: not found` } as SshError);
    return ok({ type: 'file', mode: 0o644, uid: 0, gid: 0, size: data.length, mtime: Date.now() });
  }
  writeFile(path: string, content: string): Result<void> {
    if (!this.source.write) return err({ kind: 'IO_ERROR', message: 'read-only' } as SshError);
    return this.source.write(this.canonical(path), content)
      ? ok(undefined)
      : err({ kind: 'IO_ERROR', message: 'write failed' } as SshError);
  }
  mkdir(_path: string): Result<void> { return ok(undefined); }
  deleteFile(_path: string): Result<void> { return ok(undefined); }
  rmdir(_path: string): Result<void> { return ok(undefined); }
  rename(_src: string, _dst: string): Result<void> { return ok(undefined); }
  setPermissions(_p: string, _m: number): Result<void> { return ok(undefined); }
  setOwner(_p: string, _u: number, _g: number): Result<void> { return ok(undefined); }
}
