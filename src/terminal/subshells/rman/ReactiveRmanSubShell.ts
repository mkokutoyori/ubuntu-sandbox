/**
 * ReactiveRmanSubShell — ISubShell adapter over the reactive RmanSession.
 *
 * Subscribes to session.events$ and converts each event into Oracle-
 * shaped terminal lines, accumulated in `_outputBuffer`. processLine()
 * drains the buffer after delegating to the session.
 *
 * Public entry point used by the existing RmanSubShell.create() factory:
 *   ReactiveRmanSubShell.create(args, device)   — wraps device → context
 *   ReactiveRmanSubShell.fromContext(args, ctx) — injected context (tests)
 */

import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from '../ISubShell';
import type { IRmanSession } from './session/IRmanSession';
import type { RmanEvent } from './core/types';
import type { IRmanOracleContext } from './integration/IRmanOracleContext';
import { RmanSession } from './session/RmanSession';
import { rmanErrorMessage, type RmanError } from './core/RmanError';
import { formatOracleDate } from './core/pureUtils';
import { LinuxRmanContext } from './integration/LinuxRmanContext';
import type { Equipment } from '@/network';

export class ReactiveRmanSubShell implements ISubShell {
  private readonly _outputBuffer: string[] = [];
  private readonly _unsubs: Array<() => void> = [];
  private _shouldExit = false;
  private _disposed   = false;

  private constructor(private readonly _session: IRmanSession) {
    this._wireEvents();
  }

  // ── Factories ────────────────────────────────────────────────────

  /** Test-friendly entry point: callers inject the context. */
  static fromContext(
    args: string[],
    ctx: IRmanOracleContext,
  ): { subShell: ReactiveRmanSubShell; banner: string[] } {
    const { session, banner } = RmanSession.create(args, ctx);
    return { subShell: new ReactiveRmanSubShell(session), banner };
  }

  /** Production entry point: wraps the active Equipment into a Linux context. */
  static create(
    device: Equipment,
    args: string[],
  ): { subShell: ReactiveRmanSubShell; banner: string[] } {
    const ctx = LinuxRmanContext.forDevice(device);
    return ReactiveRmanSubShell.fromContext(args, ctx);
  }

  // ── ISubShell ────────────────────────────────────────────────────

  getPrompt(): string { return 'RMAN> '; }

  handleKey(e: KeyEvent): boolean {
    if (e.key === 'd' && e.ctrlKey) { this._shouldExit = true; return true; }
    if (e.key === 'c' && e.ctrlKey) return true;
    return false;
  }

  processLine(line: string): SubShellResult {
    const trimmed = line.trim();
    if (!trimmed) return { output: [], exit: false, prompt: this.getPrompt() };

    // Drain stale buffer
    this._outputBuffer.length = 0;

    const result = this._session.processLine(trimmed);

    if (!result.ok) {
      return {
        output: this._formatRmanError(result.error),
        exit: false,
        prompt: this.getPrompt(),
      };
    }

    const upper = trimmed.toUpperCase();
    const exitNow = this._shouldExit || upper === 'EXIT' || upper === 'QUIT';

    const output = [...result.value, ...this._outputBuffer];
    this._outputBuffer.length = 0;
    return { output, exit: exitNow, prompt: this.getPrompt() };
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const u of this._unsubs) u();
    this._session.dispose();
  }

  // ── Event → text ────────────────────────────────────────────────

  private _wireEvents(): void {
    this._unsubs.push(this._session.events$.subscribe(e => this._handleEvent(e)));
  }

  private _handleEvent(e: RmanEvent): void {
    switch (e.type) {
      case 'JOB_STARTED':
        this._push('');
        this._push(`Starting ${this._opLabel(e.operation)} at ${formatOracleDate()}`);
        break;
      case 'CHANNEL_ALLOCATED':
        this._push(`allocated channel: ${e.channelId}`);
        this._push(`channel ${e.channelId}: SID=${e.sid} device type=${e.deviceType}`);
        break;
      case 'PROGRESS_UPDATED':
        this._push(e.message);
        break;
      case 'BACKUP_PIECE_CREATED':
        this._push(`piece handle=${e.piece.path} tag=${e.piece.tag.label}`);
        break;
      case 'BACKUP_SET_COMPLETE':
        this._push('channel ORA_DISK_1: backup set complete, elapsed time: 00:00:15');
        break;
      case 'RESTORE_DATAFILE_STARTED':
        this._push(`channel ${e.channelId}: restoring datafile ${String(e.fileNo).padStart(5, '0')} to ${e.to}`);
        break;
      case 'RESTORE_DATAFILE_COMPLETED':
        // We emit one "restore complete" line per file; collapsing later
        // is the SubShell's prerogative if needed.
        this._push(`channel ORA_DISK_1: restore complete, elapsed time: 00:00:25`);
        break;
      case 'RECOVER_STARTED':
        this._push('starting media recovery');
        break;
      case 'RECOVER_COMPLETED':
        this._push('media recovery complete, elapsed time: 00:00:03');
        break;
      case 'CROSSCHECK_DONE':
        this._push(`Crosschecked ${e.available + e.expired} objects`);
        if (e.expired > 0) this._push(`${e.expired} piece(s) marked EXPIRED`);
        break;
      case 'JOB_COMPLETED':
        this._push(`Finished ${this._opLabel(e.operation)} at ${formatOracleDate()}`);
        this._push('');
        break;
      case 'JOB_FAILED':
        this._push('');
        this._push('RMAN-00571: ===========================================================');
        this._push('RMAN-00569: =============== ERROR MESSAGE STACK FOLLOWS ===============');
        this._push('RMAN-00571: ===========================================================');
        this._push(`RMAN-03014: ${rmanErrorMessage(e.error)}`);
        break;
      // CONNECTED, SESSION_STATE_CHANGED, CATALOG_UPDATED, etc.
      // are internal — no terminal output.
    }
  }

  private _opLabel(op: string): string { return op.toLowerCase().replace(/_/g, ' '); }
  private _push(line: string): void { this._outputBuffer.push(line); }

  private _formatRmanError(_e: RmanError): string[] {
    return [
      'RMAN-00571: ===========================================================',
      'RMAN-00569: =============== ERROR MESSAGE STACK FOLLOWS ===============',
      'RMAN-00571: ===========================================================',
      'RMAN-00558: error encountered while parsing input command',
      'RMAN-01009: syntax error: found: unknown command',
      'RMAN-01007: at line 1 column 1 file: standard input',
    ];
  }
}
