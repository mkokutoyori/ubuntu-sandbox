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
import { createSQLPlusSession, initOracleFilesystem, syncAlertLogToDevice, updateSpfileOnDevice } from '@/terminal/commands/database';

export class SqlPlusSubShell implements ISubShell {
  private session: SQLPlusSession;
  private prompt: string;
  private device: Equipment;

  private constructor(session: SQLPlusSession, prompt: string, device: Equipment) {
    this.session = session;
    this.prompt = prompt;
    this.device = device;
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

    return {
      subShell: new SqlPlusSubShell(session, session.getPrompt(), device),
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

    // Sync alert log and spfile to VFS after commands that may modify them
    const upper = line.trim().toUpperCase();
    if (upper.startsWith('STARTUP') || upper.startsWith('SHUTDOWN') ||
        upper.startsWith('ALTER SYSTEM') || upper.startsWith('ALTER DATABASE')) {
      this.syncToVFS();
    }

    // Detect CLEAR SCREEN command
    const isClear = /^CLEAR\s+SCR/i.test(line.trim());

    return {
      output: result.output,
      exit: result.exit,
      prompt: result.prompt,
      clearScreen: isClear,
    };
  }

  /** Sync dynamic Oracle state (alert log, spfile) back to the virtual filesystem. */
  private syncToVFS(): void {
    try {
      const db = this.session.getDatabase();
      if (db) {
        syncAlertLogToDevice(this.device, db.instance.getAlertLog());
        updateSpfileOnDevice(this.device, db.instance.getSpfileParameters());
      }
    } catch {
      // Silently ignore sync errors — VFS may not be initialized
    }
  }

  dispose(): void {
    this.session.disconnect();
  }
}
