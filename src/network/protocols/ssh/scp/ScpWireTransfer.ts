/**
 * ScpWireTransfer — drives the real SCP source/sink wire protocol
 * (`ScpWireCodec.ts`, PRD-FTP-SFTP.md §2.1.19/P18) against a pair of
 * `ISftpFileSystem`s, recording the actual `C`/`D`/`E` control-line
 * sequence and the ack byte the sink would send for each line. Additive,
 * standalone: `ScpSession.ts`/`ScpTransfer.ts` keep using their existing,
 * purely semantic `readFile`/`writeFile` copy until P19 migrates them
 * onto this codec (same boundary `SftpWireSession.ts` drew for P13-P16).
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

  constructor(
    private readonly source: ISftpFileSystem,
    private readonly destination: ISftpFileSystem,
  ) {}

  /** Pushes `srcPath` (on `source`) into the existing directory `dstDir` (on `destination`). */
  push(srcPath: string, dstDir: string, opts: ScpWireTransferOptions): ScpWireTransferResult {
    const type = this.source.getEntryType(srcPath);
    if (type === null) return this.finish(this.fail(`${srcPath}: No such file or directory`));
    if (type === 'directory' && !opts.recursive) {
      return this.finish(this.fail(`${srcPath}: not a regular file`));
    }
    const ok = type === 'directory' ? this.sendDir(srcPath, dstDir) : this.sendFile(srcPath, dstDir);
    return this.finish(ok);
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

  private sendFile(srcAbs: string, sinkDir: string): boolean {
    const stat = this.source.stat(srcAbs);
    const data = this.source.readFile(srcAbs);
    if (!stat.ok || !data.ok) return this.fail(`${srcAbs}: cannot read`);

    const name = baseName(srcAbs);
    const line: ScpControlLine = { kind: 'C', mode: scpModeString(stat.value.mode), size: data.value.length, name };
    const dstPath = `${sinkDir.replace(/\/$/, '')}/${name}`;
    const write = this.destination.writeFile(dstPath, data.value);
    const ack: ScpAck = write.ok ? SCP_ACK.OK : SCP_ACK.FATAL;
    const ackMessage = write.ok ? undefined : `scp: ${dstPath}: cannot write`;
    this.record(line, ack, ackMessage, data.value.length);
    if (ack !== SCP_ACK.OK) return this.fail(ackMessage!);

    this.filesTransferred += 1;
    this.bytesTransferred += data.value.length;
    return true;
  }

  private sendDir(srcAbs: string, sinkDir: string): boolean {
    const stat = this.source.stat(srcAbs);
    const name = baseName(srcAbs);
    const line: ScpControlLine = { kind: 'D', mode: scpModeString(stat.ok ? stat.value.mode : 0o755), name };
    const childDir = `${sinkDir.replace(/\/$/, '')}/${name}`;
    this.destination.mkdir(childDir); // benign if it already exists (scp -r into an existing tree is fine)
    const ack: ScpAck = this.destination.getEntryType(childDir) === 'directory' ? SCP_ACK.OK : SCP_ACK.FATAL;
    const ackMessage = ack === SCP_ACK.OK ? undefined : `scp: ${childDir}: cannot create directory`;
    this.record(line, ack, ackMessage);
    if (ack !== SCP_ACK.OK) return this.fail(ackMessage!);

    const entries = this.source.listDirectory(srcAbs);
    if (!entries.ok) return this.fail(`${srcAbs}: cannot list directory`);
    for (const e of entries.value) {
      // Some ISftpFileSystem implementations (e.g. LinuxSftpFSAdapter) list real
      // '.'/'..' self/parent entries (matching real sftp-server READDIR semantics) —
      // a recursive walk must skip them, unlike a single-level directory listing.
      if (e.name === '.' || e.name === '..') continue;
      const childSrc = `${srcAbs.replace(/\/$/, '')}/${e.name}`;
      const ok = e.type === 'directory' ? this.sendDir(childSrc, childDir) : this.sendFile(childSrc, childDir);
      if (!ok) return false;
    }

    this.record({ kind: 'E', mode: '', name: '' }, SCP_ACK.OK);
    return true;
  }
}
