/**
 * DdlHistoryRecord — concrete `IDdlHistoryRecord`.
 *
 * Carries the metadata real Oracle would record in DBA_HIST_DDL: SCN,
 * timestamp, parsing user/schema, kind (CREATE TABLE / DROP USER / …),
 * affected object, full SQL text, and outcome. The journal allocates
 * the SCN through `IAuditJournal.nextScn()` so DDL and DML events share
 * a single monotonic timeline.
 */

import type { IDdlHistoryRecord } from './interfaces';

export class DdlHistoryRecord implements IDdlHistoryRecord {
  readonly scn: number;
  readonly timestamp: Date;
  readonly sessionId: number;
  readonly username: string;
  readonly schema: string;
  readonly kind: string;
  readonly objectType: string | null;
  readonly objectName: string;
  readonly sqlText: string | null;
  readonly success: boolean;
  readonly returncode: number;
  /** Pre-image checksum placeholder — would carry redo-block hash. */
  readonly preImageDigest: string;
  /** Post-image checksum placeholder. */
  readonly postImageDigest: string;

  constructor(init: {
    scn: number; sessionId: number; username: string; schema: string;
    kind: string; objectType?: string | null; objectName: string;
    sqlText?: string | null; success?: boolean; returncode?: number;
    timestamp?: Date;
  }) {
    this.scn = init.scn;
    this.timestamp = init.timestamp ?? new Date();
    this.sessionId = init.sessionId;
    this.username = init.username.toUpperCase();
    this.schema = init.schema.toUpperCase();
    this.kind = init.kind.toUpperCase();
    this.objectType = init.objectType ?? null;
    this.objectName = init.objectName.toUpperCase();
    this.sqlText = init.sqlText ?? null;
    this.success = init.success ?? true;
    this.returncode = init.returncode ?? 0;
    // Real Oracle would hash the affected dictionary segment. We emit
    // deterministic-looking placeholders so future log-mining code has
    // something stable to consume.
    const seed = `${this.scn}:${this.objectName}:${this.kind}`;
    this.preImageDigest = `pre-${seed.length.toString(16)}`;
    this.postImageDigest = `post-${seed.length.toString(16)}`;
  }
}
