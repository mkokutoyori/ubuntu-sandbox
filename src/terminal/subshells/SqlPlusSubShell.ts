/**
 * SqlPlusSubShell — Interactive SQL*Plus sub-shell.
 *
 * Wraps the existing SQLPlusSession into the ISubShell interface,
 * decoupling Oracle database concerns from LinuxTerminalSession.
 */

import type { Equipment } from '@/network';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';
import type { SQLPlusSession } from '@/database/oracle/commands/SQLPlusSession';
import type { HostCommandRunner } from '@/database/oracle/commands/HostCommandRunner';
import { createSQLPlusSession, initOracleFilesystem } from '@/terminal/commands/database';

interface SyncShellHost {
  executeShellCommandSync(command: string): string;
}

function asSyncShellHost(device: Equipment): SyncShellHost | null {
  const d = device as unknown as Partial<SyncShellHost>;
  return typeof d.executeShellCommandSync === 'function' ? (d as SyncShellHost) : null;
}

export class SqlPlusSubShell implements ISubShell {
  readonly kind = 'sqlplus';
  readonly connection = 'subshell' as const;
  private session: SQLPlusSession;
  private prompt: string;

  private constructor(session: SQLPlusSession, prompt: string) {
    this.session = session;
    this.prompt = prompt;
  }

  /**
   * Factory: create a SQL*Plus sub-shell for a device.
   * Initialises the Oracle filesystem and creates the session.
   *
   * @returns The sub-shell, banner lines, and login output.
   * @throws If the session cannot be created (bad credentials, etc.).
   */
  static create(
    device: Equipment,
    args: string[],
  ): { subShell: SqlPlusSubShell; banner: string[]; loginOutput: string[] } {
    initOracleFilesystem(device);
    const deviceId = device.getId();
    const { session, banner, loginOutput } = createSQLPlusSession(deviceId, args);

    const host = asSyncShellHost(device);
    if (host) {
      const runner: HostCommandRunner = {
        execute(cmd: string): string[] {
          const out = host.executeShellCommandSync(cmd);
          return out === '' ? [] : out.split('\n');
        },
      };
      session.setHostCommandRunner(runner);
    }

    return {
      subShell: new SqlPlusSubShell(session, session.getPrompt()),
      banner,
      loginOutput,
    };
  }

  getPrompt(): string {
    return this.prompt;
  }

  handleKey(e: KeyEvent): boolean {
    // Ctrl+D → exit
    if (e.key === 'd' && e.ctrlKey) return true; // signal handled by session
    // Ctrl+C → cancel current input (handled at session level)
    if (e.key === 'c' && e.ctrlKey) return true;
    // All other keys go to the view's text input
    return false;
  }

  processLine(line: string): SubShellResult {
    const result = this.session.processLine(line);
    this.prompt = result.prompt;

    // Phase 7c: the OracleFilesystemSync adapter (auto-attached by
    // getOracleDatabase) now materialises alert log, spfile, datafiles
    // and processes by subscribing to oracle.* bus events. No manual
    // post-execute sync needed.

    const isClear = /^CLEAR\s+SCR/i.test(line.trim());
    return {
      output: result.output,
      exit: result.exit,
      prompt: result.prompt,
      clearScreen: isClear,
    };
  }

  dispose(): void {
    this.session.disconnect();
  }
}
