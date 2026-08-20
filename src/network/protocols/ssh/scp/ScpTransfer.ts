/**
 * ScpTransfer — execute a single scp operation against a pair of
 * ISftpFileSystems.
 *
 * Pulls and pushes go through the SAME orchestrator: the source endpoint
 * decides which side reads, the destination decides which side writes.
 * `-r` recurses into directories, `-p` preserves mode (real scp also
 * preserves mtime via a `T` control line this codec's target model
 * doesn't carry, §4.9), `-q` is honoured by callers who want to
 * suppress the summary line.
 *
 * §2.1.20/P19: the actual copy now goes through `ScpWireTransfer`
 * (the real `C`/`D`/`E` control-line + ack-byte wire protocol,
 * `ScpWireCodec.ts`/§2.1.19/P18) instead of calling `readFile`/
 * `writeFile` directly — this class's own public surface
 * (`run()`/`ScpTransferOptions`/`ScpTransferResult`) is unchanged, only
 * the internal mechanism moved onto the real wire sequence.
 *
 * Designed in the SFTP layer so it works the same against any
 * ISftpFileSystem — Linux VFS, Windows NTFS adapter, Cisco flash:, etc.
 */

import type { ISftpFileSystem } from '../sftp/ISftpFileSystem';
import type { ScpEndpoint } from '../Scp';
import { ScpWireTransfer } from './ScpWireTransfer';

export interface ScpTransferOptions {
  readonly recursive: boolean;
  readonly preserve: boolean;
  readonly localCwd: string;
  readonly remoteCwd: string;
  readonly quiet?: boolean;
  readonly verbose?: boolean;
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
    return this.runWire(this.fs.local, this.fs.remote, srcAbs, dstAbs);
  }

  private pull(): ScpTransferResult {
    const srcAbs = this.fs.remote.normalizePath(this.source.path, this.opts.remoteCwd);
    const dstAbs = this.fs.local.normalizePath(this.destination.path, this.opts.localCwd);
    return this.runWire(this.fs.remote, this.fs.local, srcAbs, dstAbs);
  }

  private runWire(src: ISftpFileSystem, dst: ISftpFileSystem, srcAbs: string, dstAbs: string): ScpTransferResult {
    const type = src.getEntryType(srcAbs);
    if (type === null) return this.fail(`${srcAbs}: No such file or directory`);
    if (type === 'directory' && !this.opts.recursive) {
      return this.fail(`${srcAbs}: not a regular file`);
    }
    const result = new ScpWireTransfer(src, dst).push(srcAbs, dstAbs, {
      recursive: this.opts.recursive,
      preserve: this.opts.preserve,
    });
    if (!result.ok) {
      return { ok: false, filesTransferred: 0, bytesTransferred: 0, summary: '', error: result.error };
    }
    return this.summary(result.filesTransferred, result.bytesTransferred, srcAbs);
  }

  private summary(files: number, bytes: number, src: string): ScpTransferResult {
    if (this.opts.quiet) {
      return { ok: true, filesTransferred: files, bytesTransferred: bytes, summary: '' };
    }
    const name = (src.split('/').pop() ?? src).padEnd(40);
    const rate = scaleRate(bytes);
    const summary = `${name}100% ${String(bytes).padStart(5)}     ${rate}   00:00`;
    return { ok: true, filesTransferred: files, bytesTransferred: bytes, summary };
  }

  private fail(error: string): ScpTransferResult {
    return { ok: false, filesTransferred: 0, bytesTransferred: 0, summary: '', error };
  }
}

function scaleRate(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB/s`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB/s`;
  return `${bytes}B/s`;
}
