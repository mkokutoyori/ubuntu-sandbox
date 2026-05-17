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
      case 'DUPLICATE_DATABASE': return this._doDuplicate(job, channelId);
      case 'CROSSCHECK':         return this._doCrosscheck(job);
      case 'DELETE_EXPIRED':     return this._doDeleteExpired();
      case 'DELETE_OBSOLETE':    return this._doDeleteObsolete(job);
      default:                   return ok(undefined);
    }
  }

  private _doBackup(job: RmanJob, channelId: string, what: string): Result<void, RmanError> {
    const params = job.params ?? {};
    const validate = params.validate === 'true';
    const deleteInput = params.deleteInput === 'true';
    const compressed = params.compressed === 'true';
    const tag = params.tag ? RmanTag.of(params.tag) : RmanTag.generate();
    const path = this._resolvePath(params.format, tag);
    const isControlfile = params.what === 'controlfile';
    const isSpfile      = params.what === 'spfile';
    const isArchivelog  = job.operation === 'BACKUP_ARCHIVELOG';
    const incLevel = params.incrementalLevel === '0' || params.incrementalLevel === '1'
      ? (Number(params.incrementalLevel) as 0 | 1)
      : undefined;

    const allDatafiles = this._ctx.getDatafiles();
    const fileFilter = params.fileNo ? Number(params.fileNo) : undefined;
    const datafiles = fileFilter !== undefined
      ? allDatafiles.filter(df => df.fileNo === fileFilter)
      : allDatafiles;
    const size = isControlfile
      ? 9_650_176
      : isSpfile
        ? 4_096
        : (datafiles.reduce((acc, df) => acc + df.sizeBytes, 0) || 1_000_000);

    this._bus.emit({ type: 'BACKUP_PIECE_STARTED', jobId: job.id, channelId, what });

    // VALIDATE — skip the VFS write and the catalog persistence.
    if (validate) {
      this._bus.emit({ type: 'BACKUP_VALIDATED', jobId: job.id, what });
      return ok(undefined);
    }

    const writeResult = this._ctx.vfs.writeFile(path, new Uint8Array(0));
    if (!writeResult.ok) return writeResult;

    const dfEntries: DatafileEntry[] = (isControlfile || isSpfile) ? [] : datafiles.map(df => {
      const ckp = Scn.of(1_892_354);
      return Object.freeze({
        fileNo: df.fileNo, level: incLevel ?? (0 as 0 | 1),
        ckpScn: ckp.ok ? ckp.value : Scn.ZERO,
        ckpTime: Date.now(), path: df.path,
      });
    });

    const type = isControlfile  ? 'CONTROLFILE'
              : isArchivelog    ? 'ARCHIVELOG'
              : incLevel === 0  ? 'INCREMENTAL_0'
              : incLevel === 1  ? 'INCREMENTAL_1'
              :                   'FULL';
    const level = incLevel ?? 0;

    const set = BackupSetFactory.createBackupSet({
      type, level, path, sizeBytes: size, tag, datafiles: dfEntries, compressed,
    });

    this._bus.emit({
      type: 'BACKUP_PIECE_CREATED', jobId: job.id, channelId,
      piece: { key: set.pieces[0].key, tag, path, sizeBytes: size, checkpointScn: set.pieces[0].checkpointScn },
    });

    const recR = this._catalog.recordBackupSet(set);
    if (!recR.ok) return recR;

    this._bus.emit({ type: 'BACKUP_SET_COMPLETE', jobId: job.id, bsKey: set.bsKey, tag, sizeBytes: size });

    // ARCHIVELOG ALL DELETE INPUT — consume + delete every reported archivelog
    if (isArchivelog && deleteInput) {
      const paths = this._ctx.getArchivelogPaths?.() ?? [];
      for (const p of paths) {
        this._ctx.vfs.deleteFile(p);
        this._bus.emit({ type: 'ARCHIVELOG_DELETED', jobId: job.id, path: p });
      }
    }

    return ok(undefined);
  }

  /** Resolve a piece file path from an optional FORMAT template + tag. */
  private _resolvePath(format: string | undefined, tag: RmanTag): string {
    if (!format) return generatePieceName(this._ctx.dbName, tag);
    // Minimal Oracle %-substitution: %U → unique-ish suffix, %s → 1, %p → 1.
    const unique = `${this._ctx.dbName}_${Math.random().toString(36).slice(2, 10)}`;
    return format
      .replace(/%U/g, unique)
      .replace(/%s/g, '1')
      .replace(/%p/g, '1')
      .replace(/%T/g, tag.label);
  }

  private _doRestore(job: RmanJob, channelId: string): Result<void, RmanError> {
    const inst = this._ctx.getInstanceState?.();
    if (inst === 'OPEN' || inst === 'SHUTDOWN') {
      return err({ code: 'RMAN_06403', message: 'database must be mounted (not open)' });
    }
    const params = job.params ?? {};
    const snap = this._catalog.listAll();
    if (!snap.ok) return snap;
    let sets = [...snap.value.sets];
    if (params.tag) {
      sets = sets.filter(s => s.tag.label.toUpperCase() === params.tag);
      if (sets.length === 0) {
        return err({ code: 'RMAN_06023', message: `No backup with tag ${params.tag}` });
      }
    }
    if (sets.length === 0) {
      return err({ code: 'RMAN_06023', message: 'No backup found to restore' });
    }

    // PREVIEW / VALIDATE — emit a progress line and skip the actual restore.
    if (params.preview === 'true' || params.validate === 'true') {
      const kind = params.preview === 'true' ? 'preview' : 'validate';
      this._bus.emit({
        type: 'PROGRESS_UPDATED', jobId: job.id, stepName: kind, pct: 60,
        message: `restore ${kind}: ${sets.length} backup set(s) examined`,
      });
      return ok(undefined);
    }

    const tsFilter   = params.tablespace ? params.tablespace.toUpperCase() : undefined;
    const fileFilter = params.fileNo     ? Number(params.fileNo) : undefined;
    const datafiles  = this._ctx.getDatafiles().filter(df => {
      if (fileFilter !== undefined) return df.fileNo === fileFilter;
      if (tsFilter   !== undefined) return df.tablespace.toUpperCase() === tsFilter;
      return true;
    });
    if (datafiles.length === 0 && (tsFilter || fileFilter !== undefined)) {
      return err({ code: 'RMAN_06023', message: `No datafiles match the restore scope` });
    }

    for (const df of datafiles) {
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

  private _doDuplicate(job: RmanJob, channelId: string): Result<void, RmanError> {
    const aux = (job.params?.auxiliary ?? 'AUX').toUpperCase();
    const snap = this._catalog.listAll();
    if (!snap.ok) return snap;
    if (snap.value.sets.length === 0) {
      return err({ code: 'RMAN_06023', message: 'No backup found to duplicate' });
    }
    for (const df of this._ctx.getDatafiles()) {
      const dest = df.path.replace(this._ctx.dbName.toUpperCase(), aux);
      this._bus.emit({
        type: 'RESTORE_DATAFILE_STARTED', jobId: job.id, channelId,
        fileNo: df.fileNo, to: dest,
      });
      this._bus.emit({
        type: 'RESTORE_DATAFILE_COMPLETED', jobId: job.id,
        fileNo: df.fileNo, elapsedMs: 4_000,
      });
    }
    return ok(undefined);
  }

  private _doRecover(job: RmanJob): Result<void, RmanError> {
    const inst = this._ctx.getInstanceState?.();
    if (inst === 'SHUTDOWN' || inst === 'NOMOUNT') {
      return err({ code: 'RMAN_06403', message: 'database must be mounted or open' });
    }
    const params = job.params ?? {};
    let fromValue = 1_892_354;
    let toValue = 1_892_500;
    if (params.untilScn !== undefined) {
      const r = Scn.of(params.untilScn);
      if (!r.ok) return r;
      fromValue = r.value.value;
      toValue   = r.value.value;
    }
    if (params.untilTime !== undefined) {
      this._bus.emit({
        type: 'PROGRESS_UPDATED', jobId: job.id, stepName: 'until_time',
        pct: 10, message: `recovering until time ${params.untilTime}`,
      });
    }
    if (params.untilCancel === 'true') {
      this._bus.emit({
        type: 'PROGRESS_UPDATED', jobId: job.id, stepName: 'until_cancel',
        pct: 30, message: 'recovery cancelled by operator',
      });
    }
    if (params.tablespace !== undefined) {
      this._bus.emit({
        type: 'PROGRESS_UPDATED', jobId: job.id, stepName: 'recover_tablespace',
        pct: 40, message: `recovering tablespace ${params.tablespace}`,
      });
    }
    if (params.fileNo !== undefined) {
      this._bus.emit({
        type: 'PROGRESS_UPDATED', jobId: job.id, stepName: 'recover_datafile',
        pct: 40, message: `recovering datafile ${params.fileNo}`,
      });
    }
    const from = Scn.of(fromValue);
    const to   = Scn.of(toValue);
    this._bus.emit({ type: 'RECOVER_STARTED',   jobId: job.id, fromScn: from.ok ? from.value : Scn.ZERO });
    this._bus.emit({ type: 'RECOVER_COMPLETED', jobId: job.id, toScn:   to.ok   ? to.value   : Scn.ZERO, elapsedMs: 3_000 });
    return ok(undefined);
  }

  private _doCrosscheck(job?: RmanJob): Result<void, RmanError> {
    const scope = (job?.params?.scope ?? 'BACKUP').toUpperCase();
    const snap = this._catalog.listAll();
    if (!snap.ok) return snap;
    let available = 0, expired = 0;
    for (const p of snap.value.pieces) {
      const set = snap.value.sets.find(s => s.bsKey === p.bsKey);
      if (scope === 'ARCHIVELOG' && set?.type !== 'ARCHIVELOG') continue;
      if (scope === 'BACKUP'     && set?.type === 'ARCHIVELOG') continue;
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

  private _doDeleteObsolete(job: RmanJob): Result<void, RmanError> {
    const explicitKeys = (job.params?.setKeys ?? '').split(',').filter(Boolean).map(Number);
    if (explicitKeys.length === 0) return ok(undefined);
    for (const bsKey of explicitKeys) {
      const set = this._catalog.findByKey({ _tag: 'BackupKey', bsKey, bpKey: bsKey, copy: 1 });
      // Best effort: even if findByKey can't resolve via piece key, attempt delete.
      const all = this._catalog.listAll();
      if (all.ok) {
        const found = all.value.sets.find(s => s.bsKey === bsKey);
        if (found) {
          for (const p of found.pieces) this._ctx.vfs.deleteFile(p.path);
        }
      }
      void set;
      this._catalog.deleteBackupSet(bsKey);
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
