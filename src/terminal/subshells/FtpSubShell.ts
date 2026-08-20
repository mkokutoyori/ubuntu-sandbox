/**
 * FtpSubShell — interactive FTP client sub-shell (PRD-FTP-SFTP.md §2.1.11).
 *
 * Wraps `FtpClientSession` (`@/network/ftp`) into the `ISubShell` contract
 * used by `LinuxTerminalSession`, mirroring `SftpSubShell.ts`'s shape —
 * `get`/`put`/`ls`/`cd`/`lcd`/`lpwd`/`lls`/`pwd`/`bye`. Passive mode is
 * negotiated transparently before every transfer/listing command, since
 * the PRD calls for PASV as this client's default (real `ftp(1)` clients
 * do the same).
 */

import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';
import type { FtpClientSession } from '@/network/ftp/FtpClientSession';
import type { ISshLocalFs } from '@/network/protocols/ssh/ISshLocalFs';
import { expandTilde, formatTransferProgress } from '@/network/protocols/ssh/SshPureUtils';

const HELP_TEXT = `Commands may be abbreviated. Commands are:

bye                    Terminate ftp session and exit
cd remote-directory    Change remote working directory
get remote [local]     Download file
help                   Print this help text
lcd local-directory    Change local working directory
lpwd                   Print local working directory
ls [remote-directory]  List contents of remote directory
put local [remote]     Upload file
pwd                    Print remote working directory
quit                   Terminate ftp session and exit`;

function baseName(path: string): string {
  const parts = path.split('/').filter((p) => p.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export interface FtpSubShellDeps {
  readonly client: FtpClientSession;
  readonly localVfs: ISshLocalFs;
  readonly localUid: number;
  readonly localGid: number;
  readonly localHome: string;
  localCwd: string;
}

export class FtpSubShell implements ISubShell {
  readonly kind = 'ftp';
  readonly connection = 'subshell' as const;

  constructor(private readonly deps: FtpSubShellDeps) {}

  getPrompt(): string {
    return 'ftp> ';
  }

  handleKey(e: KeyEvent): boolean {
    if (e.key === 'd' && e.ctrlKey) return true;
    return false;
  }

  processLine(line: string): SubShellResult {
    const trimmed = line.trim();
    if (!trimmed) return done(['']);

    const [cmd, ...rest] = trimmed.split(/\s+/);
    const lower = cmd.toLowerCase();

    switch (lower) {
      case 'exit':
      case 'quit':
      case 'bye':
        this.deps.client.sendCommand({ verb: 'QUIT' });
        this.deps.client.close();
        return { output: ['Goodbye.'], exit: true, prompt: '' };

      case 'help':
      case '?':
        return done(HELP_TEXT.split('\n'));

      case 'pwd': {
        const r = this.deps.client.sendCommand({ verb: 'PWD' });
        return done([r ? r.lines[0] : 'Not connected.']);
      }

      case 'lpwd':
        return done([`Local directory now ${this.deps.localCwd}`]);

      case 'cd': {
        if (!rest[0]) return done(['usage: cd remote-directory']);
        const r = this.deps.client.sendCommand({ verb: 'CWD', argument: rest[0] });
        if (!r) return done(['Not connected.']);
        return done([r.lines[0]]);
      }

      case 'lcd': {
        if (!rest[0]) return done(['usage: lcd local-directory']);
        const target = this.deps.localVfs.normalizePath(
          expandTilde(rest[0], this.deps.localHome), this.deps.localCwd,
        );
        const inode = this.deps.localVfs.resolveInode(target);
        if (!inode || inode.type !== 'directory') return done([`Local directory ${target}: No such file or directory`]);
        this.deps.localCwd = target;
        return done([`Local directory now ${target}`]);
      }

      case 'ls': {
        this.deps.client.enterPassiveMode();
        const { reply, lines } = this.deps.client.list(rest[0], 'LIST');
        if (!reply) return done(['Not connected.']);
        return done(lines.length > 0 ? lines : ['']);
      }

      case 'lls': {
        const target = rest[0]
          ? this.deps.localVfs.normalizePath(expandTilde(rest[0], this.deps.localHome), this.deps.localCwd)
          : this.deps.localCwd;
        const entries = this.deps.localVfs.listDirectory(target);
        if (!entries) return done([`${target}: No such file or directory`]);
        return done(entries.map((e) => e.name));
      }

      case 'get': {
        const [remote, local] = rest;
        if (!remote) return done(['usage: get remote-file [local-file]']);
        this.deps.client.enterPassiveMode();
        const { reply, content } = this.deps.client.retrieveFile(remote);
        if (!reply || reply.code !== 226 || content === null) {
          return done([`${reply?.lines[0] ?? 'Not connected.'}`]);
        }
        const localBase = baseName(remote);
        const absLocal = local
          ? this.deps.localVfs.normalizePath(expandTilde(local, this.deps.localHome), this.deps.localCwd)
          : `${this.deps.localCwd}/${localBase}`;
        this.deps.localVfs.writeFile(absLocal, content, this.deps.localUid, this.deps.localGid, 0o022);
        return done([`local: ${absLocal} remote: ${remote}`, formatTransferProgress(localBase, content.length)]);
      }

      case 'put': {
        const [local, remote] = rest;
        if (!local) return done(['usage: put local-file [remote-file]']);
        const absLocal = this.deps.localVfs.normalizePath(expandTilde(local, this.deps.localHome), this.deps.localCwd);
        const content = this.deps.localVfs.readFile(absLocal);
        if (content === null) return done([`local: ${absLocal}: No such file or directory`]);
        this.deps.client.enterPassiveMode();
        const reply = this.deps.client.storeFile(remote ?? baseName(local), content);
        if (!reply || reply.code !== 226) return done([`${reply?.lines[0] ?? 'Not connected.'}`]);
        return done([`local: ${absLocal} remote: ${remote ?? baseName(local)}`, formatTransferProgress(baseName(local), content.length)]);
      }

      case 'clear':
        return { output: [''], exit: false, prompt: 'ftp> ', clearScreen: true };

      default:
        return done([`?Invalid command`]);
    }
  }

  dispose(): void {
    /* nothing to release: the client/session is owned by the host. */
  }
}

function done(output: string[]): SubShellResult {
  return { output, exit: false, prompt: 'ftp> ' };
}
