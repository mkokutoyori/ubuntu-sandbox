/**
 * ScpWireTransfer — drives the real SCP source/sink wire protocol
 * (`ScpWireCodec.ts`, PRD-FTP-SFTP.md §2.1.19/P18) against a pair of
 * `ISftpFileSystem`s, recording the actual `C`/`D`/`E` control-line
 * sequence and the ack byte the sink would send for each line. This is
 * what `ScpTransfer.ts` drives underneath since §2.1.20/P19 (its public
 * `run()`/`ScpTransferResult` surface is unchanged; only the internal
 * copy mechanism moved off direct `readFile`/`writeFile` calls onto this
 * real wire sequence).
 *
 * One ack per control line (not the doubled control-line-ack +
 * data-trailer-ack of the real byte-for-byte wire) — enough to prove
 * genuine protocol framing and correct-per-operation acks without
 * chasing OpenSSH's exact byte count, mirroring this simulator's
 * existing "real enough to be genuinely testable" bar elsewhere.
 */

import type { ISftpFileSystem } from '../sftp/ISftpFileSystem';
import {
  encodeScpControlLine, scpModeString, SCP_ACK, type ScpAck, type ScpControlLine,
} from './ScpWireCodec';

export interface ScpWireStep {
  readonly line: string;
  readonly dataLength?: number;
  readonly ack: ScpAck;
  readonly ackMessage?: string;
}

export interface ScpWireTransferOptions {
  readonly recursive: boolean;
  /** §2.1.19 `-p`: apply the source's real mode to the destination after a successful write/mkdir. */
  readonly preserve?: boolean;
}

export interface ScpWireTransferResult {
  readonly ok: boolean;
  readonly steps: readonly ScpWireStep[];
  readonly filesTransferred: number;
  readonly bytesTransferred: number;
  readonly error?: string;
}

function baseName(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

export class ScpWireTransfer {
  private readonly steps: ScpWireStep[] = [];
  private filesTransferred = 0;
  private bytesTransferred = 0;
  private error?: string;
  private preserve = false;

  constructor(
    private readonly source: ISftpFileSystem,
    private readonly destination: ISftpFileSystem,
  ) {}

  /**
   * Pushes `srcPath` (on `source`) to `dstTarget` (on `destination`).
   * Mirrors real `scp -t <target>` sink semantics: if `dstTarget` is an
   * existing directory, the file/tree lands inside it (named by its own
   * basename); otherwise, for a single file, `dstTarget` is used verbatim
   * as the exact destination path (rename-on-copy) — a directory source
   * always needs an (existing-or-creatable) directory target.
   */
  push(srcPath: string, dstTarget: string, opts: ScpWireTransferOptions): ScpWireTransferResult {
    this.preserve = opts.preserve ?? false;
    const type = this.source.getEntryType(srcPath);
    if (type === null) return this.finish(this.fail(`${srcPath}: No such file or directory`));
    if (type === 'directory' && !opts.recursive) {
      return this.finish(this.fail(`${srcPath}: not a regular file`));
    }
    const targetIsDir = this.destination.getEntryType(dstTarget) === 'directory';
    if (type === 'directory') return this.finish(this.sendDir(srcPath, dstTarget, targetIsDir));
    return this.finish(this.sendFile(srcPath, dstTarget, targetIsDir));
  }

  private finish(ok: boolean): ScpWireTransferResult {
    return {
      ok, steps: this.steps,
      filesTransferred: this.filesTransferred, bytesTransferred: this.bytesTransferred,
      error: ok ? undefined : this.error,
    };
  }

  private fail(error: string): boolean {
    this.error = error;
    return false;
  }

  private record(line: ScpControlLine, ack: ScpAck, ackMessage?: string, dataLength?: number): void {
    this.steps.push({ line: encodeScpControlLine(line), ack, ackMessage, dataLength });
  }

  private sendFile(srcAbs: string, dstTargetOrDir: string, targetIsDir: boolean): boolean {
    const stat = this.source.stat(srcAbs);
    const data = this.source.readFile(srcAbs);
    if (!stat.ok || !data.ok) return this.fail(`${srcAbs}: cannot read`);

    const name = baseName(srcAbs);
    const line: ScpControlLine = { kind: 'C', mode: scpModeString(stat.value.mode), size: data.value.length, name };
    const dstPath = targetIsDir ? `${dstTargetOrDir.replace(/\/$/, '')}/${name}` : dstTargetOrDir;
    const write = this.destination.writeFile(dstPath, data.value);
    const ack: ScpAck = write.ok ? SCP_ACK.OK : SCP_ACK.FATAL;
    // The wire ack carries OpenSSH's own `scp: ` prefix; `fail()` takes the
    // bare reason, since ScpSession is what renders the prefixed line.
    const reason = `${dstPath}: cannot write`;
    this.record(line, ack, write.ok ? undefined : `scp: ${reason}`, data.value.length);
    if (ack !== SCP_ACK.OK) return this.fail(reason);

    if (this.preserve) this.destination.setPermissions(dstPath, stat.value.mode);
    this.filesTransferred += 1;
    this.bytesTransferred += data.value.length;
    return true;
  }

  private sendDir(srcAbs: string, dstTargetOrDir: string, targetIsDir: boolean): boolean {
    const stat = this.source.stat(srcAbs);
    const name = baseName(srcAbs);
    const line: ScpControlLine = { kind: 'D', mode: scpModeString(stat.ok ? stat.value.mode : 0o755), name };
    // Real `scp -t <target>` sink semantics, same as sendFile: an existing directory target
    // means "nest inside me by basename"; a not-yet-existing target is the exact directory to create.
    const childDir = targetIsDir ? `${dstTargetOrDir.replace(/\/$/, '')}/${name}` : dstTargetOrDir;
    this.destination.mkdir(childDir); // benign if it already exists (scp -r into an existing tree is fine)
    const ack: ScpAck = this.destination.getEntryType(childDir) === 'directory' ? SCP_ACK.OK : SCP_ACK.FATAL;
    const dirReason = `${childDir}: cannot create directory`;
    this.record(line, ack, ack === SCP_ACK.OK ? undefined : `scp: ${dirReason}`);
    if (ack !== SCP_ACK.OK) return this.fail(dirReason);
    if (this.preserve && stat.ok) this.destination.setPermissions(childDir, stat.value.mode);

    const entries = this.source.listDirectory(srcAbs);
    if (!entries.ok) return this.fail(`${srcAbs}: cannot list directory`);
    for (const e of entries.value) {
      // Some ISftpFileSystem implementations (e.g. LinuxSftpFSAdapter) list real
      // '.'/'..' self/parent entries (matching real sftp-server READDIR semantics) —
      // a recursive walk must skip them, unlike a single-level directory listing.
      if (e.name === '.' || e.name === '..') continue;
      const childSrc = `${srcAbs.replace(/\/$/, '')}/${e.name}`;
      const ok = e.type === 'directory' ? this.sendDir(childSrc, childDir, true) : this.sendFile(childSrc, childDir, true);
      if (!ok) return false;
    }

    this.record({ kind: 'E', mode: '', name: '' }, SCP_ACK.OK);
    return true;
  }
}
