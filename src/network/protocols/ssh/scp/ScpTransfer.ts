/**
 * ScpTransfer — execute a single scp operation against a pair of
 * ISftpFileSystems.
 *
 * Pulls and pushes go through the SAME orchestrator: the source endpoint
 * decides which side reads, the destination decides which side writes.
 * `-r` recurses into directories, `-p` preserves mtime + mode, `-q` is
 * honoured by callers who want to suppress the summary line.
 *
 * Designed in the SFTP layer so it works the same against any
 * ISftpFileSystem — Linux VFS, Windows NTFS adapter, Cisco flash:, etc.
 */

import type { ISftpFileSystem, SftpDirEntry } from '../sftp/ISftpFileSystem';
import type { ScpEndpoint } from '../Scp';

export interface ScpTransferOptions {
  readonly recursive: boolean;
  readonly preserve: boolean;
  readonly localCwd: string;
  readonly remoteCwd: string;
}

export interface ScpTransferResult {
  readonly ok: boolean;
  readonly bytesTransferred: number;
  readonly filesTransferred: number;
  readonly summary: string;
  readonly error?: string;
}

interface FsPair {
  readonly local: ISftpFileSystem;
  readonly remote: ISftpFileSystem;
}

export class ScpTransfer {
  constructor(
    private readonly fs: FsPair,
    private readonly source: ScpEndpoint,
    private readonly destination: ScpEndpoint,
    private readonly opts: ScpTransferOptions,
  ) {}

  run(): ScpTransferResult {
    if (this.source.remote && this.destination.remote) {
      return this.fail('remote-to-remote copy not supported in simulator');
    }
    if (!this.source.remote && !this.destination.remote) {
      return this.fail('both endpoints local — use cp instead');
    }
    return this.source.remote ? this.pull() : this.push();
  }

  private push(): ScpTransferResult {
    const srcAbs = this.fs.local.normalizePath(this.source.path, this.opts.localCwd);
    const dstAbs = this.fs.remote.normalizePath(this.destination.path, this.opts.remoteCwd);
    const type = this.fs.local.getEntryType(srcAbs);
    if (type === null) return this.fail(`${srcAbs}: No such file or directory`);
    if (type === 'directory' && !this.opts.recursive) {
      return this.fail(`${srcAbs}: not a regular file`);
    }
    if (type === 'directory') return this.pushDir(srcAbs, dstAbs);
    return this.pushFile(srcAbs, dstAbs);
  }

  private pull(): ScpTransferResult {
    const srcAbs = this.fs.remote.normalizePath(this.source.path, this.opts.remoteCwd);
    const dstAbs = this.fs.local.normalizePath(this.destination.path, this.opts.localCwd);
    const type = this.fs.remote.getEntryType(srcAbs);
    if (type === null) return this.fail(`${srcAbs}: No such file or directory`);
    if (type === 'directory' && !this.opts.recursive) {
      return this.fail(`${srcAbs}: not a regular file`);
    }
    if (type === 'directory') return this.pullDir(srcAbs, dstAbs);
    return this.pullFile(srcAbs, dstAbs);
  }

  private pushFile(srcAbs: string, dstAbs: string): ScpTransferResult {
    const data = this.fs.local.readFile(srcAbs);
    if (!data.ok) return this.fail(`read ${srcAbs}`);
    const w = this.fs.remote.writeFile(dstAbs, data.value);
    if (!w.ok) return this.fail(`write ${dstAbs}`);
    this.preserveAttrs(this.fs.local, this.fs.remote, srcAbs, dstAbs);
    const size = data.value.length;
    return this.summary(1, size, srcAbs);
  }

  private pullFile(srcAbs: string, dstAbs: string): ScpTransferResult {
    const data = this.fs.remote.readFile(srcAbs);
    if (!data.ok) return this.fail(`read ${srcAbs}`);
    const w = this.fs.local.writeFile(dstAbs, data.value);
    if (!w.ok) return this.fail(`write ${dstAbs}`);
    this.preserveAttrs(this.fs.remote, this.fs.local, srcAbs, dstAbs);
    const size = data.value.length;
    return this.summary(1, size, srcAbs);
  }

  private pushDir(srcAbs: string, dstAbs: string): ScpTransferResult {
    this.fs.remote.mkdir(dstAbs);
    const entries = this.fs.local.listDirectory(srcAbs);
    if (!entries.ok) return this.fail(`read dir ${srcAbs}`);
    let files = 0, bytes = 0;
    for (const e of entries.value) {
      const sub = this.recurse(this.fs.local, this.fs.remote, `${srcAbs}/${e.name}`, `${dstAbs}/${e.name}`, e);
      files += sub.filesTransferred;
      bytes += sub.bytesTransferred;
      if (!sub.ok) return sub;
    }
    return this.summary(files, bytes, srcAbs);
  }

  private pullDir(srcAbs: string, dstAbs: string): ScpTransferResult {
    this.fs.local.mkdir(dstAbs);
    const entries = this.fs.remote.listDirectory(srcAbs);
    if (!entries.ok) return this.fail(`read dir ${srcAbs}`);
    let files = 0, bytes = 0;
    for (const e of entries.value) {
      const sub = this.recurse(this.fs.remote, this.fs.local, `${srcAbs}/${e.name}`, `${dstAbs}/${e.name}`, e);
      files += sub.filesTransferred;
      bytes += sub.bytesTransferred;
      if (!sub.ok) return sub;
    }
    return this.summary(files, bytes, srcAbs);
  }

  private recurse(
    src: ISftpFileSystem, dst: ISftpFileSystem,
    srcAbs: string, dstAbs: string, entry: SftpDirEntry,
  ): ScpTransferResult {
    if (entry.type === 'directory') {
      dst.mkdir(dstAbs);
      const sub = src.listDirectory(srcAbs);
      if (!sub.ok) return this.fail(`read dir ${srcAbs}`);
      let files = 0, bytes = 0;
      for (const e of sub.value) {
        const r = this.recurse(src, dst, `${srcAbs}/${e.name}`, `${dstAbs}/${e.name}`, e);
        files += r.filesTransferred; bytes += r.bytesTransferred;
        if (!r.ok) return r;
      }
      return { ok: true, filesTransferred: files, bytesTransferred: bytes, summary: '' };
    }
    const data = src.readFile(srcAbs);
    if (!data.ok) return this.fail(`read ${srcAbs}`);
    const w = dst.writeFile(dstAbs, data.value);
    if (!w.ok) return this.fail(`write ${dstAbs}`);
    this.preserveAttrs(src, dst, srcAbs, dstAbs);
    return { ok: true, filesTransferred: 1, bytesTransferred: data.value.length, summary: '' };
  }

  private preserveAttrs(src: ISftpFileSystem, dst: ISftpFileSystem, srcAbs: string, dstAbs: string): void {
    if (!this.opts.preserve) return;
    const stat = src.stat(srcAbs);
    if (!stat.ok) return;
    dst.setPermissions(dstAbs, stat.value.mode);
  }

  private summary(files: number, bytes: number, src: string): ScpTransferResult {
    const summary = `${src.split('/').pop() ?? src}                                     100% ${bytes}     ${bytes}B/s   00:00`;
    return { ok: true, filesTransferred: files, bytesTransferred: bytes, summary };
  }

  private fail(error: string): ScpTransferResult {
    return { ok: false, filesTransferred: 0, bytesTransferred: 0, summary: '', error };
  }
}
