/**
 * SftpSubShell — interactive SFTP sub-shell.
 *
 * Wraps an SftpSession into the ISubShell interface so that
 * LinuxTerminalSession can route keyboard events and line input to it.
 *
 * Supported sub-commands mirror the OpenSSH sftp(1) interactive interface
 * (draft-ietf-secsh-filexfer §6):
 *   ls [path]         — list remote directory
 *   lls [path]        — list local directory
 *   pwd               — show remote working directory
 *   lpwd              — show local working directory
 *   cd <path>         — change remote directory
 *   lcd <path>        — change local directory
 *   get <remote> [local] — download file
 *   put <local> [remote] — upload file
 *   mkdir <path>      — create remote directory
 *   rm <path>         — remove remote file
 *   rmdir <path>      — remove remote directory
 *   rename <old> <new>— rename/move remote file
 *   help / ?          — list commands
 *   exit / quit / bye — leave sftp session
 */

import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';
import type { SftpSession } from '@/network/protocols/sftp/SftpSession';

const HELP_TEXT = `Available commands:
bye                                      Quit sftp
cd path                                  Change remote directory to 'path'
exit                                     Quit sftp
get [-afpR] remote [local]               Download file
help                                     Display this help text
lcd path                                 Change local directory to 'path'
lls [ls-options [path]]                  Display local directory listing
lmkdir path                              Create local directory
lpwd                                     Print local working directory
ls [-1afhlnrSt] [path]                  Display remote directory listing
mkdir path                               Create remote directory
put [-afpR] local [remote]               Upload file
pwd                                      Display remote working directory
quit                                     Quit sftp
rename oldpath newpath                   Rename remote file
rm path                                  Delete remote file
rmdir path                               Remove remote directory
version                                  Show SFTP version`;

export class SftpSubShell implements ISubShell {
  constructor(private readonly session: SftpSession) {}

  getPrompt(): string {
    return this.session.getPrompt();
  }

  handleKey(e: KeyEvent): boolean {
    // Ctrl+D → signal exit to the session (handled as 'exit' by processLine)
    if (e.key === 'd' && e.ctrlKey) return true;
    // All other keys go to the view's text input
    return false;
  }

  processLine(line: string): SubShellResult {
    const trimmed = line.trim();

    if (!trimmed) {
      return done(['']);
    }

    const [cmd, ...rest] = trimmed.split(/\s+/);
    const lower = cmd.toLowerCase();

    switch (lower) {
      case 'exit':
      case 'quit':
      case 'bye':
        this.session.disconnect();
        return { output: [''], exit: true, prompt: '' };

      case 'help':
      case '?':
        return done(HELP_TEXT.split('\n'));

      case 'version':
        return done(['SFTP protocol version 3']);

      case 'pwd':
        return done([this.session.pwd()]);

      case 'lpwd':
        return done([this.session.lpwd()]);

      case 'ls':
        return done([this.session.ls(rest)]);

      case 'lls':
        return done([this.session.lls(rest)]);

      case 'cd':
        return doneErr(this.session.cd(rest[0] ?? ''));

      case 'lcd':
        return doneErr(this.session.lcd(rest[0] ?? ''));

      case 'get': {
        const [remote, local] = rest;
        if (!remote) return done(['usage: get remote [local]']);
        return done([this.session.get(remote, local)]);
      }

      case 'put': {
        const [local, remote] = rest;
        if (!local) return done(['usage: put local [remote]']);
        return done([this.session.put(local, remote)]);
      }

      case 'mkdir':
        return doneErr(this.session.mkdir(rest[0] ?? ''));

      case 'rm':
        return doneErr(this.session.rm(rest[0] ?? ''));

      case 'rmdir':
        return doneErr(this.session.rmdir(rest[0] ?? ''));

      case 'rename': {
        const [oldP, newP] = rest;
        if (!oldP || !newP) return done(['usage: rename oldpath newpath']);
        return doneErr(this.session.rename(oldP, newP));
      }

      default:
        return done([`Invalid command.`]);
    }
  }

  dispose(): void {
    // No resources to release beyond what the session tracks.
  }
}

// ─── Result helpers ─────────────────────────────────────────────────────────

function done(output: string[]): SubShellResult {
  return { output, exit: false, prompt: 'sftp> ' };
}

/** For commands that return '' on success or an error string. */
function doneErr(errOrEmpty: string): SubShellResult {
  return errOrEmpty
    ? done([errOrEmpty])
    : done(['']);
}
