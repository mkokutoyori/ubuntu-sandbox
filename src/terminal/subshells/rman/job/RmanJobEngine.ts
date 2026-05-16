/**
 * RmanJobEngine — orchestrates a RmanJob end-to-end.
 *
 * Lifecycle for every job:
 *   1. JOB_STARTED on the bus.
 *   2. Channel pool allocation (emits CHANNEL_ALLOCATED). On failure →
 *      JOB_FAILED + ok(undefined).
 *   3. Each step emits PROGRESS_UPDATED in order.
 *   4. Operation-specific work emits BACKUP_PIECE_CREATED, BACKUP_SET_
 *      COMPLETE, RESTORE_DATAFILE_*, RECOVER_*, CROSSCHECK_DONE,
 *      CATALOG_UPDATED (via the catalog's own stream forwarded by the
 *      session).
 *   5. Channel release (in finally) emits CHANNEL_RELEASED.
 *   6. JOB_COMPLETED on success; JOB_FAILED on any step error.
 *
 * The engine never throws — every error becomes a JOB_FAILED event.
 */

import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanJobEngine } from './IRmanJobEngine';
import type { IChannelPool } from '../channel/IChannelPool';
import type { IRmanCatalogRepository } from '../catalog/IRmanCatalogRepository';
import type { IRmanOracleContext } from '../integration/IRmanOracleContext';
import type { RmanEventBus } from '../reactive/RmanEventBus';
import type { RmanJob } from './types';
import type { DatafileEntry } from '../catalog/types';
import { BackupSetFactory } from '../catalog/BackupSetFactory';
import { RmanTag } from '../values/RmanTag';
import { Scn } from '../values/Scn';
import { generatePieceName } from '../core/pureUtils';

export class RmanJobEngine implements IRmanJobEngine {
  private readonly _cancelled = new Set<string>();

  constructor(
    private readonly _bus:     RmanEventBus,
    private readonly _pool:    IChannelPool,
    private readonly _catalog: IRmanCatalogRepository,
    private readonly _ctx:     IRmanOracleContext,
  ) {}

  run(job: RmanJob): Result<void, RmanError> {
    const start = Date.now();

    if (this._cancelled.has(job.id)) {
      return err({ code: 'JOB_CANCELLED', message: `Job ${job.id} was cancelled`, jobId: job.id });
    }

    this._bus.emit({ type: 'JOB_STARTED', jobId: job.id, operation: job.operation, startedAt: start });

    // 1. Allocate channel
    const chanResult = this._pool.allocate();
    if (!chanResult.ok) {
      this._emitFailed(job, chanResult.error, start);
      return ok(undefined);
    }
    const channel = chanResult.value;

    try {
      // 2. Stream the canned step messages
      for (const step of job.steps) {
        if (this._cancelled.has(job.id)) {
          this._bus.emit({ type: 'JOB_CANCELLED', jobId: job.id, operation: job.operation });
          return ok(undefined);
        }
        this._bus.emit({
          type: 'PROGRESS_UPDATED',
          jobId: job.id, stepName: step.name, pct: step.pct, message: step.message,
        });
      }

      // 3. Operation-specific work
      const opResult = this._executeOperation(job, channel.id);
      this._pool.release(channel);
      if (!opResult.ok) {
        this._emitFailed(job, opResult.error, start);
        return ok(undefined);
      }

      // 4. JOB_COMPLETED — emitted after the channel is released so the
      //    SubShell sees CHANNEL_RELEASED before the "Finished" line.
      this._bus.emit({
        type: 'JOB_COMPLETED', jobId: job.id, operation: job.operation,
        elapsedMs: Date.now() - start,
      });
    } catch (e) {
      this._pool.release(channel);
      this._emitFailed(job, { code: 'JOB_TIMEOUT', message: String(e), jobId: job.id }, start);
    }
    return ok(undefined);
  }

  cancel(jobId: string): void { this._cancelled.add(jobId); }

  // ── Operation dispatch ──────────────────────────────────────────

  private _executeOperation(job: RmanJob, channelId: string): Result<void, RmanError> {
    switch (job.operation) {
      case 'BACKUP_DATABASE':    return this._doBackup(job, channelId, 'database');
      case 'BACKUP_ARCHIVELOG':  return this._doBackup(job, channelId, 'archivelog');
      case 'BACKUP_TABLESPACE':  return this._doBackup(job, channelId, `tablespace ${job.params?.tablespace ?? 'USERS'}`);
      case 'RESTORE_DATABASE':   return this._doRestore(job, channelId);
      case 'RECOVER_DATABASE':   return this._doRecover(job);
      case 'CROSSCHECK':         return this._doCrosscheck();
      case 'DELETE_EXPIRED':     return this._doDeleteExpired();
      case 'DELETE_OBSOLETE':    return this._doDeleteObsolete();
      default:                   return ok(undefined);
    }
  }

  private _doBackup(job: RmanJob, channelId: string, what: string): Result<void, RmanError> {
    const tag  = RmanTag.generate();
    const path = generatePieceName(this._ctx.dbName, tag);
    const datafiles = this._ctx.getDatafiles();
    const size = datafiles.reduce((acc, df) => acc + df.sizeBytes, 0) || 1_000_000;

    this._bus.emit({ type: 'BACKUP_PIECE_STARTED', jobId: job.id, channelId, what });

    const writeResult = this._ctx.vfs.writeFile(path, new Uint8Array(0));
    if (!writeResult.ok) return writeResult;

    const dfEntries: DatafileEntry[] = datafiles.map(df => {
      const ckp = Scn.of(1_892_354);
      return Object.freeze({
        fileNo: df.fileNo, level: 0 as const,
        ckpScn: ckp.ok ? ckp.value : Scn.ZERO,
        ckpTime: Date.now(), path: df.path,
      });
    });

    const set = BackupSetFactory.createBackupSet({
      type: 'FULL', level: 0, path, sizeBytes: size, tag, datafiles: dfEntries,
    });

    this._bus.emit({
      type: 'BACKUP_PIECE_CREATED', jobId: job.id, channelId,
      piece: { key: set.pieces[0].key, tag, path, sizeBytes: size, checkpointScn: set.pieces[0].checkpointScn },
    });

    const recR = this._catalog.recordBackupSet(set);
    if (!recR.ok) return recR;

    this._bus.emit({ type: 'BACKUP_SET_COMPLETE', jobId: job.id, bsKey: set.bsKey, tag, sizeBytes: size });
    return ok(undefined);
  }

  private _doRestore(job: RmanJob, channelId: string): Result<void, RmanError> {
    const snap = this._catalog.listAll();
    if (!snap.ok) return snap;
    if (snap.value.sets.length === 0) {
      return err({ code: 'RMAN_06023', message: 'No backup found to restore' });
    }
    for (const df of this._ctx.getDatafiles()) {
      this._bus.emit({
        type: 'RESTORE_DATAFILE_STARTED', jobId: job.id, channelId,
        fileNo: df.fileNo, to: df.path,
      });
      this._bus.emit({
        type: 'RESTORE_DATAFILE_COMPLETED', jobId: job.id,
        fileNo: df.fileNo, elapsedMs: 5_000,
      });
    }
    return ok(undefined);
  }

  private _doRecover(job: RmanJob): Result<void, RmanError> {
    const from = Scn.of(1_892_354);
    const to   = Scn.of(1_892_500);
    this._bus.emit({ type: 'RECOVER_STARTED',   jobId: job.id, fromScn: from.ok ? from.value : Scn.ZERO });
    this._bus.emit({ type: 'RECOVER_COMPLETED', jobId: job.id, toScn:   to.ok   ? to.value   : Scn.ZERO, elapsedMs: 3_000 });
    return ok(undefined);
  }

  private _doCrosscheck(): Result<void, RmanError> {
    const snap = this._catalog.listAll();
    if (!snap.ok) return snap;
    let available = 0, expired = 0;
    for (const p of snap.value.pieces) {
      if (this._ctx.vfs.fileExists(p.path)) available++;
      else { this._catalog.expirePiece(p.key); expired++; }
    }
    this._bus.emit({ type: 'CROSSCHECK_DONE', available, expired });
    return ok(undefined);
  }

  private _doDeleteExpired(): Result<void, RmanError> {
    const expired = this._catalog.listExpired();
    if (!expired.ok) return expired;
    const seen = new Set<number>();
    for (const p of expired.value) {
      if (seen.has(p.bsKey)) continue;
      seen.add(p.bsKey);
      // best-effort: delete the file too
      this._ctx.vfs.deleteFile(p.path);
      this._catalog.deleteBackupSet(p.bsKey);
    }
    return ok(undefined);
  }

  private _doDeleteObsolete(): Result<void, RmanError> {
    const obs = this._catalog.listObsolete(1);
    if (!obs.ok) return obs;
    for (const set of obs.value) {
      for (const p of set.pieces) this._ctx.vfs.deleteFile(p.path);
      this._catalog.deleteBackupSet(set.bsKey);
    }
    return ok(undefined);
  }

  private _emitFailed(job: RmanJob, error: RmanError, start: number): void {
    this._bus.emit({
      type: 'JOB_FAILED', jobId: job.id, operation: job.operation,
      error, elapsedMs: Date.now() - start,
    });
  }
}
