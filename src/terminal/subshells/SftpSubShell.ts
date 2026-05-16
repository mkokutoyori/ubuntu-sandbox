/**
 * SftpSubShell — interactive SFTP sub-shell.
 *
 * Wraps the new ssh-stack SftpSession into the ISubShell contract used by
 * LinuxTerminalSession. Implements OpenSSH `sftp(1)` interactive commands
 * including the BRD additions: lmkdir, chmod, chown, stat, df, version,
 * Ctrl+D quit, and `-l/-a/-1` flag parsing for `ls`.
 *
 * Reference: BRD-SSH-SFTP.md SFTP-10/11/12/14/15/16/17 ;
 *            DESIGN-SSH-SFTP.md section 9.3.
 */

import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';
import { ParsedArgs } from '@/network/protocols/ssh/sftp/ParsedArgs';
import type { SftpSession } from '@/network/protocols/ssh/sftp/SftpSession';

const HELP_TEXT = `Available commands:
bye                                      Quit sftp
cd path                                  Change remote directory to 'path'
chmod mode path                          Change permissions of file
chown uid path                           Change owner of file
df [-h] [path]                           Display statistics for current dir or filesystem
exit                                     Quit sftp
get [-afpR] remote [local]               Download file
help                                     Display this help text
lcd path                                 Change local directory to 'path'
lls [ls-options [path]]                  Display local directory listing
lmkdir path                              Create local directory
lpwd                                     Print local working directory
ls [-1afhlnrSt] [path]                   Display remote directory listing
mkdir path                               Create remote directory
put [-afpR] local [remote]               Upload file
pwd                                      Display remote working directory
quit                                     Quit sftp
rename oldpath newpath                   Rename remote file
rm path                                  Delete remote file
rmdir path                               Remove remote directory
stat path                                Display file attributes
version                                  Show SFTP version`;

export class SftpSubShell implements ISubShell {
  constructor(private readonly session: SftpSession) {}

  getPrompt(): string {
    return this.session.getPrompt();
  }

  /**
   * Ctrl+D / Ctrl+C quit the sub-shell. Returning true tells the host to
   * call processLine('') with our injected exit instruction; we intercept
   * that path through a synthesized 'exit' command in handleKey-via-line.
   * (LinuxTerminalSession routes Ctrl+D through processLine on its own.)
   */
  handleKey(e: KeyEvent): boolean {
    if (e.key === 'd' && e.ctrlKey) return true;
    return false;
  }

  processLine(line: string): SubShellResult {
    const trimmed = line.trim();
    if (!trimmed) return done(['']);

    const [cmd, ...rest] = trimmed.split(/\s+/);
    const lower = cmd.toLowerCase();
    const args = ParsedArgs.parse(rest);

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
        return done([this.session.version()]);

      case 'pwd':
        return done([this.session.pwd()]);

      case 'lpwd':
        return done([this.session.lpwd()]);

      case 'ls':
        return done([this.session.ls(args.positional, args.flags)]);

      case 'lls':
        return done([this.session.lls(args.positional)]);

      case 'cd':
        return doneErr(this.session.cd(args.positional[0] ?? ''));

      case 'lcd':
        return doneErr(this.session.lcd(args.positional[0] ?? ''));

      case 'lmkdir':
        if (!args.positional[0]) return done(['usage: lmkdir path']);
        return doneErr(this.session.lmkdir(args.positional[0]));

      case 'get': {
        const [remote, local] = args.positional;
        if (!remote) return done(['usage: get remote [local]']);
        return done(this.session.get(remote, local).split('\n'));
      }

      case 'put': {
        const [local, remote] = args.positional;
        if (!local) return done(['usage: put local [remote]']);
        return done(this.session.put(local, remote).split('\n'));
      }

      case 'mkdir':
        if (!args.positional[0]) return done(['usage: mkdir path']);
        return doneErr(this.session.mkdir(args.positional[0]));

      case 'rm':
        if (!args.positional[0]) return done(['usage: rm path']);
        return doneErr(this.session.rm(args.positional[0]));

      case 'rmdir':
        if (!args.positional[0]) return done(['usage: rmdir path']);
        return doneErr(this.session.rmdir(args.positional[0]));

      case 'rename': {
        const [oldP, newP] = args.positional;
        if (!oldP || !newP) return done(['usage: rename oldpath newpath']);
        return doneErr(this.session.rename(oldP, newP));
      }

      case 'chmod': {
        const [mode, path] = args.positional;
        if (!mode || !path) return done(['usage: chmod mode path']);
        return done([this.session.chmod(mode, path)]);
      }

      case 'chown': {
        const [uid, path] = args.positional;
        if (!uid || !path) return done(['usage: chown uid path']);
        return done([this.session.chown(uid, path)]);
      }

      case 'stat':
        if (!args.positional[0]) return done(['usage: stat path']);
        return done(this.session.stat(args.positional[0]).split('\n'));

      case 'df':
        return done(this.session.df(args.positional[0], args.has('h')).split('\n'));

      case 'clear':
        return { output: [''], exit: false, prompt: 'sftp> ', clearScreen: true };

      default:
        return done(['Invalid command.']);
    }
  }

  dispose(): void {
    /* nothing to release: session is owned by the host. */
  }
}

function done(output: string[]): SubShellResult {
  return { output, exit: false, prompt: 'sftp> ' };
}

function doneErr(errOrEmpty: string): SubShellResult {
  return errOrEmpty ? done([errOrEmpty]) : done(['']);
}
