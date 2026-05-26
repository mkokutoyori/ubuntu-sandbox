/**
 * DmlHistoryRecord — concrete `IDmlHistoryRecord`.
 *
 * Captures the same fields LogMiner / V$LOGMNR_CONTENTS would expose for
 * a DML row change, plus tx id and an SCN allocated by the journal.
 */

import type { IDmlHistoryRecord } from './interfaces';

export class DmlHistoryRecord implements IDmlHistoryRecord {
  readonly scn: number;
  readonly timestamp: Date;
  readonly sessionId: number;
  readonly username: string;
  readonly schema: string;
  readonly table: string;
  readonly action: 'INSERT' | 'UPDATE' | 'DELETE' | 'MERGE' | 'SELECT';
  readonly rowsAffected: number;
  readonly sqlText: string | null;
  readonly txId: number | null;
  /** Reserved for future use — LogMiner ROWID list. */
  readonly affectedRowIds: string[] = [];
  /** Redo size estimate (bytes). Computed from sqlText length. */
  readonly redoBytes: number;
  /** Undo size estimate (bytes). */
  readonly undoBytes: number;

  constructor(init: {
    scn: number; sessionId: number; username: string; schema: string;
    table: string; action: 'INSERT' | 'UPDATE' | 'DELETE' | 'MERGE' | 'SELECT';
    rowsAffected: number; sqlText?: string | null; txId?: number | null;
    timestamp?: Date;
  }) {
    this.scn = init.scn;
    this.timestamp = init.timestamp ?? new Date();
    this.sessionId = init.sessionId;
    this.username = init.username.toUpperCase();
    this.schema = init.schema.toUpperCase();
    this.table = init.table.toUpperCase();
    this.action = init.action;
    this.rowsAffected = init.rowsAffected;
    this.sqlText = init.sqlText ?? null;
    this.txId = init.txId ?? null;
    const textLen = (init.sqlText ?? '').length;
    this.redoBytes = Math.max(64, textLen * 2 + init.rowsAffected * 96);
    this.undoBytes = init.action === 'SELECT' ? 0 : this.redoBytes / 2;
  }
}
