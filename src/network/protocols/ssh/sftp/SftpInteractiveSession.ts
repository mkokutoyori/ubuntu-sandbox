/**
 * SftpInteractiveSession — executes a parsed SftpCommandScript against a
 * pair of file systems (local + remote), emitting the same line-by-line
 * trace OpenSSH's sftp client produces.
 *
 * The session is single-shot: construct, call `run(script)`, read
 * `transcript` and `lastError`. State (cwd, lcwd) is held on the
 * instance so successive commands compose like a real REPL.
 */

import type { ISftpFileSystem } from './ISftpFileSystem';
import type { SftpCommand, SftpCommandParseError } from './SftpCommand';
import type { SftpCommandScript, SftpScriptEntry } from './SftpCommandScript';
import type { SshError } from '../Result';

function sshErrorMessage(e: SshError): string {
  switch (e.kind) {
    case 'IO_ERROR':           return e.message;
    case 'PERMISSION_DENIED':  return 'Permission denied';
    case 'INVALID_ARGUMENT':   return e.message;
    case 'CONNECTION_REFUSED': return 'Connection refused';
    case 'NOT_AUTHENTICATED':  return 'Not authenticated';
    case 'AUTH_FAILED':        return 'Authentication failed';
    case 'CHANNEL_ERROR':      return e.message;
    case 'UNKNOWN_OP':         return `unknown op ${e.op}`;
    case 'HOST_KEY_CHANGED':   return 'host key changed';
    case 'HOST_KEY_REJECTED':  return 'host key rejected';
  }
}

export interface SftpSessionInit {
  readonly local: ISftpFileSystem;
  readonly remote: ISftpFileSystem;
  readonly initialRemoteCwd?: string;
  readonly initialLocalCwd?: string;
}

export class SftpInteractiveSession {
  private readonly local: ISftpFileSystem;
  private readonly remote: ISftpFileSystem;
  private remoteCwd: string;
  private localCwd: string;
  private readonly lines: string[] = [];
  private _lastError: string | null = null;

  constructor(init: SftpSessionInit) {
    this.local = init.local;
    this.remote = init.remote;
    this.remoteCwd = init.initialRemoteCwd ?? '/';
    this.localCwd  = init.initialLocalCwd  ?? '/';
  }

  get transcript(): string {
    return this.lines.join('\n');
  }

  get lastError(): string | null {
    return this._lastError;
  }

  run(script: SftpCommandScript): void {
    for (const entry of script.effective()) {
      if (entry.error) { this.recordError(entry.error); continue; }
      if (!entry.command) continue;
      this.dispatch(entry, entry.command);
      if (entry.command.verb === 'bye') break;
    }
  }

  private dispatch(entry: SftpScriptEntry, cmd: SftpCommand): void {
    switch (cmd.verb) {
      case 'put':    return this.doPut(cmd.local, cmd.remote);
      case 'get':    return this.doGet(cmd.remote, cmd.local);
      case 'ls':     return this.doLs(cmd.path);
      case 'lls':    return this.doLls(cmd.path);
      case 'cd':     return this.doCd(cmd.path);
      case 'lcd':    return this.doLcd(cmd.path);
      case 'pwd':    this.lines.push(`Remote working directory: ${this.remoteCwd}`); return;
      case 'lpwd':   this.lines.push(`Local working directory: ${this.localCwd}`);   return;
      case 'mkdir':  return this.doMkdir(cmd.path);
      case 'rmdir':  return this.doRmdir(cmd.path);
      case 'rm':     return this.doRm(cmd.path);
      case 'chmod':  return this.doChmod(cmd.mode, cmd.path);
      case 'rename': return this.doRename(cmd.src, cmd.dst);
      case 'bye':    return;
    }
  }

  private doPut(localPath: string, remotePath: string): void {
    const absLocal  = this.local.normalizePath(localPath, this.localCwd);
    const absRemote = this.remote.normalizePath(remotePath, this.remoteCwd);
    const data = this.local.readFile(absLocal);
    if (!data.ok) { this.recordError({ kind: 'parse', line: `put ${localPath}`, reason: `local ${absLocal}: open failed` }); return; }
    const w = this.remote.writeFile(absRemote, data.value);
    if (!w.ok) { this.recordError({ kind: 'parse', line: `put ${localPath}`, reason: `remote ${absRemote}: write failed` }); return; }
    this.lines.push(`Uploading ${absLocal} to ${absRemote}`);
  }

  private doGet(remotePath: string, localPath: string): void {
    const absLocal  = this.local.normalizePath(localPath, this.localCwd);
    const absRemote = this.remote.normalizePath(remotePath, this.remoteCwd);
    const data = this.remote.readFile(absRemote);
    if (!data.ok) { this.recordError({ kind: 'parse', line: `get ${remotePath}`, reason: `remote ${absRemote}: not found` }); return; }
    const w = this.local.writeFile(absLocal, data.value);
    if (!w.ok) { this.recordError({ kind: 'parse', line: `get ${remotePath}`, reason: `local ${absLocal}: write failed` }); return; }
    this.lines.push(`Fetching ${absRemote} to ${absLocal}`);
  }

  private doLs(path: string | null): void {
    const target = this.remote.normalizePath(path ?? '.', this.remoteCwd);
    const r = this.remote.listDirectory(target);
    if (!r.ok) { this.recordError({ kind: 'parse', line: `ls ${path ?? ''}`, reason: 'list failed' }); return; }
    for (const e of r.value) this.lines.push(e.name);
  }

  private doLls(path: string | null): void {
    const target = this.local.normalizePath(path ?? '.', this.localCwd);
    const r = this.local.listDirectory(target);
    if (!r.ok) { this.recordError({ kind: 'parse', line: `lls ${path ?? ''}`, reason: 'list failed' }); return; }
    for (const e of r.value) this.lines.push(e.name);
  }

  private doCd(path: string): void {
    const target = this.remote.normalizePath(path, this.remoteCwd);
    if (this.remote.getEntryType(target) !== 'directory') {
      this.recordError({ kind: 'parse', line: `cd ${path}`, reason: `${target}: Not a directory` });
      return;
    }
    this.remoteCwd = target;
  }

  private doLcd(path: string): void {
    const target = this.local.normalizePath(path, this.localCwd);
    if (this.local.getEntryType(target) !== 'directory') {
      this.recordError({ kind: 'parse', line: `lcd ${path}`, reason: `${target}: Not a directory` });
      return;
    }
    this.localCwd = target;
  }

  private doMkdir(path: string): void {
    const target = this.remote.normalizePath(path, this.remoteCwd);
    const r = this.remote.mkdir(target);
    if (!r.ok) this.recordError({ kind: 'parse', line: `mkdir ${path}`, reason: `Couldn't create directory: ${sshErrorMessage(r.error)}` });
  }

  private doRmdir(path: string): void {
    const target = this.remote.normalizePath(path, this.remoteCwd);
    const r = this.remote.rmdir(target);
    if (!r.ok) this.recordError({ kind: 'parse', line: `rmdir ${path}`, reason: `Couldn't remove directory: ${sshErrorMessage(r.error)}` });
  }

  private doRm(path: string): void {
    const target = this.remote.normalizePath(path, this.remoteCwd);
    const r = this.remote.deleteFile(target);
    if (!r.ok) this.recordError({ kind: 'parse', line: `rm ${path}`, reason: `Couldn't delete file: ${sshErrorMessage(r.error)}` });
  }

  private doChmod(mode: number, path: string): void {
    const target = this.remote.normalizePath(path, this.remoteCwd);
    const r = this.remote.setPermissions(target, mode);
    if (!r.ok) this.recordError({ kind: 'parse', line: `chmod ${mode.toString(8)} ${path}`, reason: `Couldn't setstat on "${target}": ${sshErrorMessage(r.error)}` });
  }

  private doRename(src: string, dst: string): void {
    const a = this.remote.normalizePath(src, this.remoteCwd);
    const b = this.remote.normalizePath(dst, this.remoteCwd);
    const r = this.remote.rename(a, b);
    if (!r.ok) this.recordError({ kind: 'parse', line: `rename ${src} ${dst}`, reason: `Couldn't rename file "${a}" to "${b}": ${sshErrorMessage(r.error)}` });
  }

  private recordError(e: SftpCommandParseError): void {
    this._lastError = e.reason;
    this.lines.push(e.reason);
  }
}
