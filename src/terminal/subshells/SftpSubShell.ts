/**
 * SftpSubShell — interactive SFTP sub-shell.
 *
 * Hôte REPL mince : chaque ligne est routée vers l'interpreter command-kernel
 * dédié au shell sftp (`createSftpShell`, framework §14.4) — les commandes de
 * navigation vivent dans leur propre registre avec descripteur/privilèges.
 * Le switch legacy ne subsiste que pour les commandes pas encore migrées
 * (transferts et mutations — Push B du plan DESIGN-SFTP-COMMAND-KERNEL.md).
 *
 * Reference: BRD-SSH-SFTP.md SFTP-10/11/12/14/15/16/17 ;
 *            DESIGN-SSH-SFTP.md section 9.3 ; DESIGN-SFTP-COMMAND-KERNEL.md.
 */

import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';
import { CommandNotFoundError } from '@/command-kernel/errors';
import { PipeBuffer } from '@/command-kernel/io/pipe-buffer';
import { ExitRequest } from '@/command-kernel/shell/exit';
import type { Interpreter } from '@/command-kernel/interpreter';
import type { Session } from '@/command-kernel/session/types';
import { createSftpShell } from '@/network/protocols/ssh/sftp/command-kernel/createSftpShell';
import { ParsedArgs } from '@/network/protocols/ssh/sftp/ParsedArgs';
import type { SftpSession } from '@/network/protocols/ssh/sftp/SftpSession';

export class SftpSubShell implements ISubShell {
  readonly kind = 'sftp';
  readonly connection = 'subshell' as const;
  private readonly interpreter: Interpreter;
  private readonly kernelSession: Session;

  constructor(private readonly session: SftpSession) {
    const shell = createSftpShell(session);
    this.interpreter = shell.interpreter;
    this.kernelSession = shell.session;
  }

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

  async processLine(line: string): Promise<SubShellResult> {
    let trimmed = line.trim();
    if (!trimmed) return done(['']);
    // Les verbes sftp(1) sont insensibles à la casse (`PWD` ≡ `pwd`) —
    // normalisés ici, à l'entrée de l'hôte, jamais dans le registre.
    const verbEnd = trimmed.search(/\s|$/);
    trimmed = trimmed.slice(0, verbEnd).toLowerCase() + trimmed.slice(verbEnd);

    this.kernelSession.cwd = this.session.getLocalCwdPath();
    const stdout = new PipeBuffer();
    const io = { stdin: new PipeBuffer(), stdout, stderr: stdout };
    try {
      await this.interpreter.interpretLine(trimmed, this.kernelSession, io);
      this.session.setLocalCwdPath(this.kernelSession.cwd);
      const text = (await stdout.readAll()).replace(/\n$/, '');
      return done(text.split('\n'));
    } catch (err) {
      if (err instanceof ExitRequest) {
        this.session.disconnect();
        return { output: [''], exit: true, prompt: '' };
      }
      if (err instanceof CommandNotFoundError) {
        return this.processLegacy(trimmed);
      }
      throw err;
    }
  }

  private processLegacy(trimmed: string): SubShellResult {
    const [cmd, ...rest] = trimmed.split(/\s+/);
    const lower = cmd.toLowerCase();
    const args = ParsedArgs.parse(rest);

    switch (lower) {
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
