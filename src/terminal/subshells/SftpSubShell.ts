/**
 * SftpSubShell — interactive SFTP sub-shell.
 *
 * Hôte REPL mince : chaque ligne est routée vers l'interpreter command-kernel
 * dédié au shell sftp (`createSftpShell`, framework §14.4) — les commandes de
 * navigation vivent dans leur propre registre avec descripteur/privilèges.
 * Toutes les commandes de la session (navigation, transferts, mutations)
 * vivent dans le registre command-kernel — plus aucun switch legacy.
 *
 * Reference: BRD-SSH-SFTP.md SFTP-10/11/12/14/15/16/17 ;
 *            DESIGN-SSH-SFTP.md section 9.3 ; DESIGN-SFTP-COMMAND-KERNEL.md.
 */

import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';
import { CommandNotFoundError } from '@/command-kernel/errors';
import { ExitRequest } from '@/command-kernel/shell/exit';
import type { Interpreter } from '@/command-kernel/interpreter';
import type { Session } from '@/command-kernel/session/types';
import { createSftpShell } from '@/network/protocols/ssh/sftp/command-kernel/createSftpShell';
import { normalizeSftpVerbCase, runSftpLine } from '@/network/protocols/ssh/sftp/command-kernel/runSftpLine';
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
    const trimmed = line.trim();
    if (!trimmed) return done(['']);
    // Les verbes sftp(1) sont insensibles à la casse (`PWD` ≡ `pwd`) —
    // normalisés ici, à l'entrée de l'hôte, jamais dans le registre.
    const verb = normalizeSftpVerbCase(trimmed);
    try {
      const text = await runSftpLine({ interpreter: this.interpreter, session: this.kernelSession }, this.session, verb);
      return done(text.split('\n'));
    } catch (err) {
      if (err instanceof ExitRequest) {
        this.session.disconnect();
        return { output: [''], exit: true, prompt: '' };
      }
      if (err instanceof CommandNotFoundError) {
        if (trimmed.split(/\s+/)[0] === 'clear') {
          return { output: [''], exit: false, prompt: 'sftp> ', clearScreen: true };
        }
        return done(['Invalid command.']);
      }
      throw err;
    }
  }

  dispose(): void {
    /* nothing to release: session is owned by the host. */
  }
}

function done(output: string[]): SubShellResult {
  return { output, exit: false, prompt: 'sftp> ' };
}

