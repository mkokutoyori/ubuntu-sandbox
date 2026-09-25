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
import type {
  IRmanOracleContext, ArchivedLogRecord, BlockCorruptionType, DatafileInfo, ShippedDatafile,
} from '../integration/IRmanOracleContext';
import {
  validateBackupPiece, pieceFaultMessage, datafileFault, type PieceVerdict,
} from '../core/pieceValidation';
import { archivedLogFromPath } from '../core/archivedLogNaming';
import type { RmanEventBus } from '../reactive/RmanEventBus';
import type { RmanJob } from './types';
import type { ValidatedFile } from '../core/types';
import type { DatafileEntry, BackupSet } from '../catalog/types';
import { BackupSetFactory } from '../catalog/BackupSetFactory';
import { RmanTag } from '../values/RmanTag';
import { Scn } from '../values/Scn';
import { generatePieceName } from '../core/pureUtils';
import type { OmfBackupKind } from '@/database/oracle/storage/OracleManagedFiles';
import { ORACLE_CONFIG } from '@/database/oracle/OracleConfig';
import { resolveFormatSpec } from '../core/formatSpec';
import { renderBackupPieceImage, parseBackupPieceImage } from '../core/BackupPieceImage';
import { restorePreviewLines } from '../core/backupSetReport';
import { renderControlFileImage, controlFileBody, type ControlFileImage } from '@/database/oracle/storage/ControlFileImage';
import { parseRedoStream, applyRedoToTablespace, type RedoRecord } from '@/database/oracle/storage/RedoStream';
import { parseDatafileImage, renderDatafileImage, datafileBannerOf } from '@/database/oracle/storage/DatafileImage';

const bySequence = (a: ArchivedLogRecord, b: ArchivedLogRecord): number =>
  a.thread - b.thread || a.sequence - b.sequence;


import type { TablespacePayload } from '@/database/oracle/OracleStorage';
import { parseSize } from '@/database/oracle/views/_fileSize';
import { BackupKey } from '../values/BackupKey';
import { implicitToDate } from '@/database/oracle/functions/valueUtils';

export class RmanJobEngine implements IRmanJobEngine {
  private readonly _cancelled = new Set<string>();
  // Set once an actual RESTORE has put datafiles back at an older
  // checkpoint; only then does the following RECOVER genuinely need
  // archivelogs to catch back up to the current SCN. A RECOVER invoked
  // on its own (no preceding RESTORE this session) has no known gap to
  // bridge, matching the many real-world call sites that recover a
  // still-current datafile after a routine offline/online cycle.
  private _pendingRecoveryGap = false;

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
    if (chanResult.ok === false) {
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
      if (opResult.ok === false) {
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
    // `BACKUP VALIDATE` porte l'operation BACKUP pour ses lignes de
    // banniere, mais fait le travail de VALIDATE : une seule implantation.
    if (job.params?.validate === 'true' && job.operation === 'BACKUP_DATABASE') {
      return this._doValidate(job);
    }
    switch (job.operation) {
      case 'BACKUP_DATABASE':    return this._doBackup(job, channelId, 'database');
      case 'BACKUP_ARCHIVELOG':  return this._doBackup(job, channelId, 'archivelog');
      case 'BACKUP_TABLESPACE':  return this._doBackup(job, channelId, `tablespace ${job.params?.tablespace ?? 'USERS'}`);
      case 'VALIDATE':           return this._doValidate(job);
      case 'BLOCK_RECOVER':      return this._doBlockRecover(job);
      case 'RECOVER_COPY':       return this._doRecoverCopy(job);
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
    const deleteInput = params.deleteInput === 'true';
    const compressed = params.compressed === 'true';
    const encrypted  = params.encrypted  === 'true';
    const tag = params.tag ? RmanTag.of(params.tag) : RmanTag.generate();
    const isControlfile = params.what === 'controlfile';
    const isSpfile      = params.what === 'spfile';
    const isArchivelog  = job.operation === 'BACKUP_ARCHIVELOG';
    const incLevel = params.incrementalLevel === '0' || params.incrementalLevel === '1'
      ? (Number(params.incrementalLevel) as 0 | 1)
      : undefined;
    const isAutobackup = isControlfile && tag.label.toUpperCase() === 'AUTOBACKUP';
    const omfKind: OmfBackupKind =
      isAutobackup             ? 'autobackup'
        : isControlfile || isSpfile ? 'controlfile-spfile'
        : isArchivelog          ? 'archivelog'
          : incLevel === 0      ? 'datafile-incremental-0'
            : incLevel === 1    ? 'datafile-incremental-1'
              : 'datafile-full';
    const maxPieceSize = params.maxPieceSize ? Number(params.maxPieceSize) : undefined;

    const allDatafiles = this._ctx.getDatafiles();
    // Multi-fileNo : params.fileNo peut contenir "4" ou "1,2,3"
    const fileFilters = params.fileNo
      ? new Set(params.fileNo.split(',').map(s => Number(s.trim())).filter(Number.isFinite))
      : null;
    // Multi-tablespace : params.tablespace peut contenir "USERS" ou "SYSTEM,USERS"
    const tsFilters = params.tablespace
      ? new Set(params.tablespace.split(',').map(s => s.trim().toUpperCase()))
      : null;
    // Exclusions de CONFIGURE EXCLUDE FOR TABLESPACE name (CSV)
    const tsExclusions = new Set(
      (params.excludeTablespaces ?? '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    );
    const datafiles = allDatafiles.filter(df => {
      if (tsExclusions.has(df.tablespace.toUpperCase())) return false;
      if (fileFilters && !fileFilters.has(df.fileNo)) return false;
      if (tsFilters   && !tsFilters.has(df.tablespace.toUpperCase())) return false;
      return true;
    });
    // `%f` et `%N` ne valent que pour une COPIE IMAGE, qui porte un seul
    // fichier : un jeu de sauvegarde en couvre plusieurs, et il n'y
    // aurait aucun fichier ni aucun tablespace a nommer.
    const fichierUnique = params.asCopy === 'true' && datafiles.length === 1
      ? { fileNumber: datafiles[0].fileNo, tablespace: datafiles[0].tablespace }
      : undefined;
    // Le controle de corruption lit le disque AVANT le point de
    // controle : celui-ci reecrit l'image entiere du datafile depuis la
    // memoire, donc il effacerait ce qu'on cherche a constater.
    if (!isControlfile && !isSpfile && !isArchivelog) {
      const refus = this._refuseCorruptDatafiles(job, datafiles);
      if (refus !== null) return refus;
    }
    const basePath = this._resolvePath(params.format, tag, omfKind, 1, fichierUnique);

    const cumulative = params.cumulative === 'true';
    const rawSize = isControlfile
      ? 9_650_176
      : isSpfile
        ? 4_096
        : (datafiles.reduce((acc, df) => acc + df.sizeBytes, 0) || 1_000_000);
    // A LEVEL 1 backup only covers blocks changed since its reference
    // backup, so it must be smaller than a LEVEL 0/FULL. Modelled as a
    // fixed fraction of the full size (real Oracle's typical 5-15%
    // range) rather than tracking actual changed blocks — enough to
    // make "incremental is smaller" reliably demonstrable without a
    // change-tracking simulation. CUMULATIVE spans back to the last
    // LEVEL 0 (a longer window than a plain differential LEVEL 1), so
    // it gets the larger end of that range.
    const isIncrementalLevel1 = incLevel === 1 && !isControlfile && !isSpfile && !isArchivelog;
    const totalSize = isIncrementalLevel1
      ? Math.max(1, Math.round(rawSize * (cumulative ? 0.15 : 0.05)))
      : rawSize;

    this._bus.emit({ type: 'BACKUP_PIECE_STARTED', jobId: job.id, channelId, what });

    // BACKUP NOT BACKED UP n TIMES — count existing FULL/INCREMENTAL sets;
    // if the file is already covered enough times, skip it (no piece, no
    // catalog write) just like Oracle's backup optimization does.
    const nbTimes = params.notBackedUpNTimes ? Number(params.notBackedUpNTimes) : undefined;
    if (nbTimes !== undefined && !isControlfile && !isSpfile && !isArchivelog) {
      const snap = this._catalog.listAll();
      if (snap.ok) {
        const coverCount = snap.value.sets.filter(s =>
          s.type === 'FULL' || s.type === 'INCREMENTAL_0' || s.type === 'INCREMENTAL_1'
        ).length;
        if (coverCount >= nbTimes) {
          this._bus.emit({ type: 'BACKUP_VALIDATED', jobId: job.id, what: `${what} (already backed up ${coverCount} times)` });
          return ok(undefined);
        }
      }
    }

    const dfEntries: DatafileEntry[] = (isControlfile || isSpfile) ? [] : datafiles.map(df => {
      const ckp = Scn.of(1_892_354);
      return Object.freeze({
        fileNo: df.fileNo, level: incLevel ?? (0 as 0 | 1),
        ckpScn: ckp.ok ? ckp.value : Scn.ZERO,
        ckpTime: Date.now(), path: df.path,
      });
    });

    // BACKUP ... FOR RECOVER OF COPY : le premier tour n'a aucune copie
    // a mettre a jour, donc il en POSE une (niveau 0). Les tours
    // suivants produisent le niveau 1 qui lui sera applique.
    let posePremiereCopie = false;
    if (params.forRecoverOfCopy === 'true') {
      posePremiereCopie = this._copiesOfTag(tag).length === 0;
      if (posePremiereCopie) {
        for (const df of datafiles) {
          this._bus.emit({
            type: 'PROGRESS_UPDATED', jobId: job.id, stepName: 'no_parent', pct: 15,
            message: `no parent backup or copy of datafile ${df.fileNo} found`,
          });
        }
      }
    }

    // BACKUP AS COPY — un DATAFILECOPY par datafile, pas de set agrégé.
    // Chaque copie va dans son propre BackupSet de type DATAFILECOPY.
    if ((params.asCopy === 'true' || posePremiereCopie)
      && !isControlfile && !isSpfile && !isArchivelog) {
      const ckpR = Scn.of(1_892_354);
      const ckp = ckpR.ok ? ckpR.value : Scn.ZERO;
      this._ctx.checkpointDatafiles?.();
      const imagesCopiees = this._readDatafileImages(datafiles);
      for (const df of datafiles) {
        const copyPath = `${basePath}.df${df.fileNo}`;
        // Une copie image EST le datafile : elle porte son image, sans
        // quoi elle ne serait restaurable ni applicable a rien.
        const corps = renderBackupPieceImage(
          `[ORACLE RMAN DATAFILE COPY - ${df.sizeBytes} bytes]`,
          { datafiles: { [df.path]: imagesCopiees[df.path] ?? '' },
            scn: this._ctx.getCurrentScn?.() },
        );
        const writeR = this._ctx.vfs.writeFile(
          copyPath, new TextEncoder().encode(corps), df.sizeBytes);
        if (!writeR.ok) return writeR;
        const set = BackupSetFactory.createBackupSet({
          type: 'DATAFILECOPY', level: 0, path: copyPath,
          sizeBytes: df.sizeBytes, tag,
          datafiles: [Object.freeze({
            fileNo: df.fileNo, level: 0 as 0 | 1,
            ckpScn: ckp, ckpTime: Date.now(), path: df.path,
          })],
          compressed, encrypted,
        });
        this._bus.emit({
          type: 'BACKUP_PIECE_CREATED', jobId: job.id, channelId,
          piece: { key: set.pieces[0].key, tag, path: copyPath, sizeBytes: df.sizeBytes, checkpointScn: set.pieces[0].checkpointScn },
        });
        const recR = this._catalog.recordBackupSet(set);
        if (!recR.ok) return recR;
        this._bus.emit({ type: 'BACKUP_SET_COMPLETE', jobId: job.id, bsKey: set.bsKey, tag, sizeBytes: df.sizeBytes });
      }
      return ok(undefined);
    }

    const type = isControlfile  ? 'CONTROLFILE'
              : isArchivelog    ? 'ARCHIVELOG'
              : incLevel === 0  ? 'INCREMENTAL_0'
              : incLevel === 1  ? 'INCREMENTAL_1'
              :                   'FULL';
    const level = incLevel ?? 0;

    const keepNote = params.keepForever === 'true'
      ? 'KEEP FOREVER'
      : params.keepUntilTime
        ? `KEEP UNTIL TIME ${params.keepUntilTime}`
        : undefined;

    // MAXPIECESIZE — split the logical backup into N piece files. Each
    // piece is its own BackupSet/BackupPiece in the catalog so LIST BACKUP
    // shows them individually.
    const pieceCount = maxPieceSize ? Math.max(1, Math.ceil(totalSize / maxPieceSize)) : 1;
    const pieceSize  = maxPieceSize ? Math.min(maxPieceSize, totalSize) : totalSize;

    if (!isControlfile && !isSpfile) this._ctx.checkpointDatafiles?.();
    const image = (isControlfile || isSpfile)
      ? null
      : isArchivelog
        ? { datafiles: {}, archivedLogs: this._readArchivedLogImages(), scn: this._ctx.getCurrentScn?.() }
        : { datafiles: this._readDatafileImages(datafiles), scn: this._ctx.getCurrentScn?.() };
    const usedPaths = new Set<string>();
    for (let i = 1; i <= pieceCount; i++) {
      const candidate = i === 1
        ? basePath
        : this._resolvePath(params.format, tag, omfKind, i, fichierUnique);
      const path = usedPaths.has(candidate) ? `${candidate}.p${i}` : candidate;
      usedPaths.add(path);
      const size = i === pieceCount
        ? (totalSize - pieceSize * (pieceCount - 1))
        : pieceSize;
      if (!params.format) {
        const overflow = this._recoveryAreaOverflow(size);
        if (overflow) return err(overflow);
      }
      const body = isControlfile
        ? renderControlFileImage(`[ORACLE RMAN BACKUP PIECE - ${size} bytes]`, this._controlFileImage())
        : renderBackupPieceImage(
          `[ORACLE RMAN BACKUP PIECE - ${size} bytes]`, i === 1 ? image : null);
      const writeResult = this._ctx.vfs.writeFile(path, new TextEncoder().encode(body), size);
      if (!writeResult.ok) return writeResult;

      const set = BackupSetFactory.createBackupSet({
        type, level, path, sizeBytes: size, tag,
        datafiles: i === 1 ? dfEntries : [],
        compressed, encrypted, keepNote,
      });

      this._bus.emit({
        type: 'BACKUP_PIECE_CREATED', jobId: job.id, channelId,
        piece: { key: set.pieces[0].key, tag, path, sizeBytes: size, checkpointScn: set.pieces[0].checkpointScn },
      });

      const recR = this._catalog.recordBackupSet(set);
      if (!recR.ok) return recR;
      this._ctx.recordBackupPiece?.({
        setId: set.bsKey, pieceId: set.pieces[0].key.bpKey,
        type: isControlfile ? 'CONTROLFILE'
          : isSpfile       ? 'SPFILE'
          : isArchivelog   ? 'ARCHIVELOG'
          : incLevel === undefined ? 'FULL' : 'INCREMENTAL',
        handle: path, bytes: size,
        startedAt: set.startTime, completedAt: set.completionTime,
      });

      this._bus.emit({ type: 'BACKUP_SET_COMPLETE', jobId: job.id, bsKey: set.bsKey, tag, sizeBytes: size });
    }

    // Une sauvegarde rend a nouveau recuperables les fichiers qu'une
    // ecriture NOLOGGING avait laisses sans redo : c'est exactement ce
    // que REPORT UNRECOVERABLE cesse alors de signaler.
    if (!isControlfile && !isSpfile && !isArchivelog) {
      for (const ts of new Set(datafiles.map(df => df.tablespace))) {
        this._ctx.clearUnrecoverable?.(ts);
      }
    }

    this._refreshControlFiles();

    // ARCHIVELOG ALL DELETE INPUT — consume + delete every reported archivelog
    if (isArchivelog && deleteInput) {
      const paths = this._archivedLogs().map(l => l.path);
      for (const p of paths) {
        this._ctx.vfs.deleteFile(p);
        this._bus.emit({ type: 'ARCHIVELOG_DELETED', jobId: job.id, path: p });
      }
    }

    return ok(undefined);
  }

  private _readDatafileImages(
    datafiles: ReadonlyArray<{ path: string }>,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const df of datafiles) {
      const read = this._ctx.vfs.readFile(df.path);
      if (read.ok) out[df.path] = new TextDecoder().decode(read.value);
    }
    return out;
  }

  private _restoredScn = 0;

  private _readPieceImages(
    sets: ReadonlyArray<{ pieces: ReadonlyArray<{ path: string }> }>,
  ): Record<string, string> {
    for (const set of sets) {
      for (const piece of set.pieces) {
        const read = this._ctx.vfs.readFile(piece.path);
        if (!read.ok) continue;
        const image = parseBackupPieceImage(new TextDecoder().decode(read.value));
        if (image) {
          this._restoredScn = image.scn ?? 0;
          return { ...image.datafiles };
        }
      }
    }
    return {};
  }

  private _archivedLogs(): ReadonlyArray<ArchivedLogRecord> {
    const declares = this._ctx.getArchivedLogs?.();
    if (declares !== undefined) return [...declares].sort(bySequence);
    const paths = this._ctx.getArchivelogPaths?.() ?? [];
    return paths.map((p, i) => archivedLogFromPath(p, i)).sort(bySequence);
  }

  private _readArchivedLogImages(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const log of this._archivedLogs()) {
      const read = this._ctx.vfs.readFile(log.path);
      if (read.ok) out[log.path] = new TextDecoder().decode(read.value);
    }
    return out;
  }

  private _restoreArchivedLogFromBackup(path: string): boolean {
    const snap = this._catalog.listAll();
    if (snap.ok === false) return false;
    for (const set of snap.value.sets) {
      if (set.type !== 'ARCHIVELOG') continue;
      for (const piece of set.pieces) {
        const read = this._ctx.vfs.readFile(piece.path);
        if (read.ok === false) continue;
        const image = parseBackupPieceImage(new TextDecoder().decode(read.value));
        const body = image?.archivedLogs?.[path];
        if (body === undefined) continue;
        const written = this._ctx.vfs.writeFile(path, new TextEncoder().encode(body));
        if (written.ok) return true;
      }
    }
    return false;
  }

  private _applyArchivedLogs(paths: ReadonlyArray<string>, untilScn?: number): void {
    const pending: RedoRecord[] = [];
    for (const path of paths) {
      const read = this._ctx.vfs.readFile(path);
      if (read.ok === false) continue;
      const text = new TextDecoder().decode(read.value);
      const image = parseBackupPieceImage(text);
      if (image && (untilScn === undefined || image.scn === undefined || image.scn <= untilScn)) {
        for (const [dfPath, body] of Object.entries(image.datafiles)) {
          this._ctx.vfs.writeFile(dfPath, new TextEncoder().encode(body));
        }
        pending.length = 0;
        continue;
      }
      for (const rec of parseRedoStream(text)) {
        if (rec.scn <= this._restoredScn) continue;
        if (untilScn === undefined || rec.scn <= untilScn) pending.push(rec);
      }
    }
    this._applyRedoRecords(pending);
  }

  private _applyRedoRecords(records: readonly RedoRecord[]): void {
    if (records.length === 0) return;
    const byFile = new Map<string, TablespacePayload>();
    for (const df of this._ctx.getDatafiles()) {
      const read = this._ctx.vfs.readFile(df.path);
      if (read.ok === false) continue;
      const payload = parseDatafileImage(new TextDecoder().decode(read.value));
      if (payload) byFile.set(df.path, payload);
    }
    const ordered = [...records].sort((a, b) => a.scn - b.scn || a.seq - b.seq);
    for (const rec of ordered) {
      for (const [path, payload] of byFile) {
        byFile.set(path, applyRedoToTablespace(payload, rec));
      }
    }
    for (const [path, payload] of byFile) {
      const read = this._ctx.vfs.readFile(path);
      if (read.ok === false) continue;
      const banner = datafileBannerOf(new TextDecoder().decode(read.value));
      this._ctx.vfs.writeFile(path,
        new TextEncoder().encode(renderDatafileImage(banner, payload)));
    }
  }

  private _controlFileImage(): ControlFileImage {
    const snap = this._catalog.listAll();
    return {
      dbName: this._ctx.dbName,
      dbId: this._ctx.dbId.value,
      datafiles: this._ctx.getDatafiles().map(df => ({
        fileNo: df.fileNo, path: df.path, sizeBytes: df.sizeBytes, tablespace: df.tablespace,
      })),
      backupSets: snap.ok ? [...snap.value.sets] : [],
    };
  }

  private _refreshControlFiles(): void {
    const paths = this._ctx.getControlFilePaths?.() ?? [];
    if (paths.length === 0) return;
    const image = this._controlFileImage();
    paths.forEach((path, index) => {
      this._ctx.vfs.writeFile(path, new TextEncoder().encode(controlFileBody(index, image)));
    });
  }

  restoreControlFilesFromImage(image: ControlFileImage): number {
    const paths = this._ctx.getControlFilePaths?.() ?? [];
    paths.forEach((path, index) => {
      this._ctx.vfs.writeFile(path, new TextEncoder().encode(controlFileBody(index, image)));
    });
    let restored = 0;
    for (const raw of image.backupSets) {
      const set = raw as import('../catalog/types').BackupSet;
      if (!set || typeof set !== 'object' || !Array.isArray(set.pieces)) continue;
      if (this._catalog.recordBackupSet(set).ok) restored++;
    }
    return restored;
  }

  private _recoveryAreaOverflow(sizeBytes: number): RmanError | null {
    const limitText = this._ctx.getSpfileParam('db_recovery_file_dest_size');
    const limit = parseSize(limitText);
    if (limit <= 0) return null;
    const used = this._ctx.getRecoveryAreaUsedBytes?.() ?? 0;
    if (used + sizeBytes <= limit) return null;
    return {
      code: 'VFS_NO_SPACE',
      message: `ORA-19809: limit exceeded for recovery files\n`
        + `ORA-19804: cannot reclaim ${sizeBytes} bytes disk space from ${limit} limit`,
      available: Math.max(0, limit - used),
    };
  }

  /** Resolve a piece file path from an optional FORMAT template + tag. */
  private _resolvePath(
    format: string | undefined, tag: RmanTag, kind: OmfBackupKind, pieceNumber = 1,
    seul?: { fileNumber?: number; tablespace?: string },
  ): string {
    if (!format) {
      const dest = this._ctx.getSpfileParam('db_recovery_file_dest') ?? ORACLE_CONFIG.FRA;
      const path = generatePieceName(this._ctx.dbName, tag, dest, kind);
      this._ctx.vfs.ensureDirectory?.(path.slice(0, path.lastIndexOf('/')));
      return path;
    }
    return resolveFormatSpec(format, {
      dbName:       this._ctx.dbName,
      dbId:         this._ctx.dbId.value,
      activationId: this._ctx.dbId.value % 1_000_000_000,
      setNumber:    BackupKey.peekBsKey(),
      pieceNumber,
      copyNumber:   1,
      logSequence:  1,
      logThread:    1,
      at:           new Date(),
      fileNumber:   seul?.fileNumber,
      tablespace:   seul?.tablespace,
    });
  }

  private _doRestore(job: RmanJob, channelId: string): Result<void, RmanError> {
    const params = job.params ?? {};
    // PREVIEW et VALIDATE n'ecrivent aucun datafile : l'exigence de
    // l'etat MOUNT ne porte que sur la forme qui en REECRIT.
    const lectureSeule = params.preview === 'true' || params.validate === 'true';
    const inst = this._ctx.getInstanceState?.();
    if (!lectureSeule && (inst === 'OPEN' || inst === 'SHUTDOWN')) {
      return err({ code: 'RMAN_06403', message: 'database must be mounted (not open)' });
    }
    if (lectureSeule && inst === 'SHUTDOWN') {
      return err({ code: 'RMAN_04014', message: 'startup failed: ORA-01034: ORACLE not available' });
    }
    const snap = this._catalog.listAll();
    if (snap.ok === false) return snap;
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

    // SET UNTIL SCN/TIME (PITR) — only backup sets checkpointed at or
    // before the requested bound are eligible; a later set would restore
    // data past the point-in-time the operator asked to recover to.
    if (params.untilScn !== undefined || params.untilTime !== undefined) {
      const untilScn  = params.untilScn !== undefined ? Number(params.untilScn) : undefined;
      const untilTime = params.untilTime !== undefined ? implicitToDate(params.untilTime) : undefined;
      sets = sets.filter(s => {
        if (untilScn !== undefined) return s.pieces[0].checkpointScn.value <= untilScn;
        if (untilTime) return s.completionTime <= untilTime.getTime();
        return true;
      });
      if (sets.length === 0) {
        return err({
          code: 'RMAN_06026',
          message: 'no backup or copy of the database is available to satisfy the requested SET UNTIL bound',
        });
      }
    }

    if (params.preview === 'true') {
      this._bus.emit({
        type: 'PROGRESS_UPDATED', jobId: job.id, stepName: 'preview', pct: 60,
        message: restorePreviewLines(sets, this._archivedLogs(),
          params.untilScn !== undefined ? Number(params.untilScn) : undefined).join('\n'),
      });
      return ok(undefined);
    }
    // RESTORE ... VALIDATE repond a la meme question que VALIDATE
    // BACKUPSET — « ce jeu est-il restaurable ? » — et doit donc lire
    // les pieces par le meme predicat, sans rien ecrire sur le disque.
    if (params.validate === 'true') {
      for (const set of sets) {
        for (const piece of set.pieces) {
          const verdict = validateBackupPiece(this._ctx.vfs, piece.path);
          if (verdict.fault !== null) {
            return err({ code: 'ERROR_STACK', message: pieceFaultMessage(verdict) });
          }
          this._bus.emit({
            type: 'PROGRESS_UPDATED', jobId: job.id, stepName: 'validate_piece', pct: 70,
            message: `channel ORA_DISK_1: reading from backup piece ${piece.path}`,
          });
        }
      }
      this._bus.emit({ type: 'VALIDATION_REPORT', jobId: job.id, files: [], elapsedMs: 1_000 });
      return ok(undefined);
    }

    // A catalog entry is only restorable while its piece files are still
    // physically on disk. RMAN used to restore from a backup set whose
    // piece had been `rm`'d — the catalog said yes, the filesystem said
    // the bytes were gone. Real RMAN fails over past the missing piece
    // and, with nothing left, aborts (RMAN-06026/06023).
    const refusees: PieceVerdict[] = [];
    const usableSets = sets.filter(s => {
      const verdicts = s.pieces.map(p => validateBackupPiece(this._ctx.vfs, p.path));
      const casses = verdicts.filter(v => v.fault !== null);
      refusees.push(...casses);
      return casses.length === 0;
    });
    if (usableSets.length === 0) {
      const premier = refusees[0];
      this._bus.emit({
        type: 'PROGRESS_UPDATED', jobId: job.id, stepName: 'restore', pct: 0,
        message: premier ? pieceFaultMessage(premier) : '',
      });
      const premierFichier = this._ctx.getDatafiles()[0]?.fileNo ?? 1;
      return err({
        code: 'ERROR_STACK',
        message: 'RMAN-06026: some targets not found - aborting restore\n'
          + `RMAN-06023: no backup or copy of datafile ${premierFichier} found to restore`,
      });
    }

    const restoredImages = this._readPieceImages(usableSets);
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
      // A restore puts the datafile back on disk — that's its whole
      // point. The instance's OPEN-time existence check (ORA-01157)
      // relies on this file being really rewritten.
      const sizeMb = Math.max(1, Math.round(df.sizeBytes / 1048576));
      const saved = restoredImages[df.path];
      this._ctx.vfs.writeFile(df.path, new TextEncoder().encode(
        saved ?? `[ORACLE DATAFILE - ${df.tablespace} tablespace - ${sizeMb}M]`));
      this._bus.emit({
        type: 'RESTORE_DATAFILE_COMPLETED', jobId: job.id,
        fileNo: df.fileNo, elapsedMs: 5_000,
      });
    }
    this._pendingRecoveryGap = true;
    return ok(undefined);
  }

  private _auxiliaryContext: IRmanOracleContext | null = null;

  setAuxiliaryContext(ctx: IRmanOracleContext | null): void {
    this._auxiliaryContext = ctx;
  }

  private _doDuplicate(job: RmanJob, channelId: string): Result<void, RmanError> {
    if (job.params?.forStandby === 'true') return this._doDuplicateForStandby(job, channelId);
    const aux = (job.params?.auxiliary ?? 'AUX').toUpperCase();
    const snap = this._catalog.listAll();
    if (snap.ok === false) return snap;
    if (snap.value.sets.length === 0) {
      return err({ code: 'RMAN_06023', message: 'No backup found to duplicate' });
    }
    const images = this._readPieceImages(snap.value.sets);
    const target = this._auxiliaryContext ?? this._ctx;
    for (const df of this._ctx.getDatafiles()) {
      const dest = df.path.replace(this._ctx.dbName.toUpperCase(), aux);
      this._bus.emit({
        type: 'RESTORE_DATAFILE_STARTED', jobId: job.id, channelId,
        fileNo: df.fileNo, to: dest,
      });
      target.vfs.ensureDirectory?.(dest.slice(0, dest.lastIndexOf('/')));
      const body = images[df.path];
      const written = target.vfs.writeFile(
        dest, new TextEncoder().encode(body ?? `[ORACLE DATAFILE - ${aux} duplicate]`));
      if (written.ok === false) return written;
      this._bus.emit({
        type: 'RESTORE_DATAFILE_COMPLETED', jobId: job.id,
        fileNo: df.fileNo, elapsedMs: 4_000,
      });
    }
    return ok(undefined);
  }

  private _standbyRefusal(reason: string): RmanError {
    return {
      code: 'ERROR_STACK',
      message: `RMAN-05501: aborting duplication of target database\n${reason}`,
    };
  }

  private _doDuplicateForStandby(job: RmanJob, channelId: string): Result<void, RmanError> {
    const params = job.params ?? {};
    const aux = this._auxiliaryContext;
    if (!aux) {
      return err(this._standbyRefusal('RMAN-06171: not connected to auxiliary database'));
    }
    const auxState = aux.getInstanceState?.() ?? 'NOMOUNT';
    if (auxState === 'MOUNT' || auxState === 'OPEN') {
      return err(this._standbyRefusal(
        'RMAN-05500: the auxiliary database must be not mounted when issuing a DUPLICATE command'));
    }
    const fromActive = params.fromActive === 'true';
    let images: Record<string, string> = {};
    if (!fromActive) {
      const snap = this._catalog.listAll();
      if (snap.ok === false) return snap;
      if (snap.value.sets.length === 0) {
        return err({ code: 'RMAN_06023', message: 'No backup found to duplicate' });
      }
      images = this._readPieceImages(snap.value.sets);
    } else {
      this._ctx.checkpointDatafiles?.();
    }
    const datafiles = this._ctx.getDatafiles();
    if (params.noFilenameCheck !== 'true') {
      const shared = datafiles[0];
      if (shared) {
        return err(this._standbyRefusal(
          `RMAN-05001: auxiliary file name ${shared.path} conflicts with a file used by the target database`));
      }
    }
    const dbUniqueName = this._ctx.getSpfileParam('db_unique_name') ?? this._ctx.dbName;
    for (const path of this._controlFilePaths()) {
      const body = this._localFileBody(path);
      if (body === null) continue;
      const sent = this._sendToAuxiliary(aux, {
        fileNo: 0, path, tablespace: '', tablespaceType: 'CONTROLFILE',
        sizeBytes: body.length, body, fromDbUniqueName: dbUniqueName, kind: 'CONTROLFILE',
      });
      if (sent.ok === false) return sent;
    }
    for (const df of datafiles) {
      const body = fromActive ? this._localFileBody(df.path) : (images[df.path] ?? null);
      if (body === null) {
        return err(this._standbyRefusal(
          `ORA-01110: data file ${df.fileNo}: '${df.path}'`));
      }
      this._bus.emit({
        type: 'RESTORE_DATAFILE_STARTED', jobId: job.id, channelId,
        fileNo: df.fileNo, to: df.path,
      });
      const sent = this._sendToAuxiliary(aux, {
        fileNo: df.fileNo, path: df.path, tablespace: df.tablespace,
        tablespaceType: 'PERMANENT', sizeBytes: df.sizeBytes, body,
        fromDbUniqueName: dbUniqueName, kind: 'DATAFILE',
      });
      if (sent.ok === false) return sent;
      this._bus.emit({
        type: 'RESTORE_DATAFILE_COMPLETED', jobId: job.id,
        fileNo: df.fileNo, elapsedMs: 4_000,
      });
    }
    const mounted = aux.runSqlStatement?.('ALTER DATABASE MOUNT STANDBY DATABASE');
    if (!mounted) {
      return err(this._standbyRefusal('RMAN-06171: not connected to auxiliary database'));
    }
    if (mounted.ok === false) {
      return err(this._standbyRefusal(mounted.error));
    }
    this._bus.emit({
      type: 'PROGRESS_UPDATED', jobId: job.id, stepName: 'mount_standby', pct: 80,
      message: 'sql statement: alter database mount standby database',
    });
    if (params.doRecover === 'true') {
      aux.runSqlStatement?.('ALTER DATABASE RECOVER MANAGED STANDBY DATABASE');
      aux.runSqlStatement?.('ALTER DATABASE RECOVER MANAGED STANDBY DATABASE CANCEL');
      this._bus.emit({
        type: 'PROGRESS_UPDATED', jobId: job.id, stepName: 'recover_standby', pct: 90,
        message: 'recover clone database',
      });
    }
    return ok(undefined);
  }

  private _controlFilePaths(): ReadonlyArray<string> {
    const declared = this._ctx.getControlFilePaths?.();
    if (declared && declared.length > 0) return declared;
    const single = this._ctx.getControlFilePath?.();
    return single ? [single] : [];
  }

  private _localFileBody(path: string): string | null {
    const read = this._ctx.vfs.readFile(path);
    if (read.ok === false) return null;
    const body = new TextDecoder().decode(read.value);
    return body.length === 0 ? null : body;
  }

  private _sendToAuxiliary(
    aux: IRmanOracleContext, file: ShippedDatafile,
  ): Result<void, RmanError> {
    if (aux.receiveDatafile) return aux.receiveDatafile(file);
    aux.vfs.ensureDirectory?.(file.path.slice(0, file.path.lastIndexOf('/')));
    return aux.vfs.writeFile(file.path, new TextEncoder().encode(file.body), file.sizeBytes);
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
      if (r.ok === false) return r;
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
    // Émet une ligne par archivelog "applied" — Oracle imprime
    //   "archived log for thread 1 with sequence 42 is already on disk
    //    as file /u01/.../arch_1_42_xxx.arc"
    // pour chaque log appliqué pendant le RECOVER. On synthétise un set
    // raisonnable autour des SCN from/to.
    const logs = this._archivedLogs();
    if (this._pendingRecoveryGap && logs.length === 0) {
      return err({
        code: 'RMAN_06054',
        message: 'media recovery requesting unknown archived log for thread 1'
          + ` with sequence 1 and starting SCN of ${this._restoredScn}`,
      });
    }
    const absent = logs.filter(l =>
      !this._ctx.vfs.fileExists(l.path) && !this._restoreArchivedLogFromBackup(l.path));
    if (absent.length > 0) {
      return err({
        code: 'RMAN_06053',
        message: ['unable to perform media recovery because of missing log']
          .concat(absent.map(l => `RMAN-06025: no backup of archived log for thread ${l.thread}`
            + ` with sequence ${l.sequence} and starting SCN of ${l.firstScn}`
            + ' found to restore'))
          .join('\n'),
      });
    }
    const arcPaths = logs.map(l => l.path);
    for (const log of logs) {
      const firstScn = log.firstScn > 0 ? log.firstScn : log.sequence;
      this._bus.emit({
        type: 'ARCHIVELOG_APPLIED', jobId: job.id,
        thread: log.thread, sequence: log.sequence, path: log.path,
        firstScn, nextScn: log.nextScn > firstScn ? log.nextScn : firstScn + 1,
      });
    }
    this._applyArchivedLogs(arcPaths, params.untilScn !== undefined ? Number(params.untilScn) : undefined);
    this._bus.emit({ type: 'RECOVER_COMPLETED', jobId: job.id, toScn:   to.ok   ? to.value   : Scn.ZERO, elapsedMs: 3_000 });
    this._pendingRecoveryGap = false;
    return ok(undefined);
  }

  private _maxCorruptOf(params: Readonly<Record<string, string>>): Map<number, number> {
    const limites = new Map<number, number>();
    for (const paire of (params.maxCorrupt ?? '').split(',')) {
      const [fichier, limite] = paire.split(':');
      if (fichier && limite) limites.set(Number(fichier), Number(limite));
    }
    return limites;
  }

  private _refuseCorruptDatafiles(
    job: RmanJob,
    datafiles: ReadonlyArray<DatafileInfo>,
  ): Result<void, RmanError> | null {
    const params = job.params ?? {};
    const limites = this._maxCorruptOf(params);
    const kind = params.asCopy === 'true' ? 'COPY' : 'BACKUPSET';
    const setStamp = Math.floor(Date.now() / 1000);
    const blockSize = Number(this._ctx.getSpfileParam('db_block_size') ?? 8192) || 8192;
    for (const df of datafiles) {
      const defaut = datafileFault(this._ctx.vfs, df, params.checkLogical === 'true');
      if (defaut === null) continue;
      const blocs = Math.max(1, Math.ceil(df.sizeBytes / blockSize));
      const limite = limites.get(df.fileNo) ?? 0;
      // Les blocs sont corrompus DANS LA BASE dans les deux cas :
      // V$DATABASE_BLOCK_CORRUPTION les porte, refus ou non.
      this._ctx.recordBlockCorruption?.(df.fileNo, blocs, defaut);
      if (blocs > limite) {
        return err({
          code: 'ERROR_STACK',
          message: `ORA-19566: exceeded limit of ${limite} corrupt blocks for file ${df.path}`,
        });
      }
      // Tolere : ils partent DANS la piece, marques corrompus — et
      // c'est cela seul que V$BACKUP_CORRUPTION enregistre, puisqu'un
      // jeu refuse n'a produit aucune sauvegarde a decrire.
      this._ctx.recordBackupCorruption?.({
        setStamp, fileNo: df.fileNo, blocks: blocs,
        markedCorrupt: true, type: defaut, kind,
      });
      this._bus.emit({
        type: 'PROGRESS_UPDATED', jobId: job.id, stepName: 'maxcorrupt', pct: 40,
        message: `channel ORA_DISK_1: backing up blocks marked corrupt in datafile ${df.fileNo}`,
      });
    }
    return null;
  }

  private _doValidate(job: RmanJob): Result<void, RmanError> {
    const params = job.params ?? {};
    if (params.validateScope === 'BACKUPSET') return this._validateBackupset(job, params.bsKey);
    const tsFilter = params.tablespace?.toUpperCase();
    const fileFilter = params.fileNo === undefined ? undefined : Number(params.fileNo);
    const datafiles = this._ctx.getDatafiles().filter(df => {
      if (fileFilter !== undefined) return df.fileNo === fileFilter;
      if (tsFilter !== undefined)   return df.tablespace.toUpperCase() === tsFilter;
      return true;
    });
    if (datafiles.length === 0) {
      return err({ code: 'RMAN_06023', message: 'No datafiles match the validate scope' });
    }
    const blockSize = Number(this._ctx.getSpfileParam('db_block_size') ?? 8192) || 8192;
    const highScn = this._ctx.getCurrentScn?.() ?? 0;
    const absent = datafiles.find(df => !this._ctx.vfs.fileExists(df.path));
    if (absent) {
      return err({
        code: 'ERROR_STACK',
        message: `ORA-19505: failed to identify file "${absent.path}"\n`
          + 'ORA-27037: unable to obtain file status',
      });
    }
    const checkLogical = params.checkLogical === 'true';
    const defauts = new Map<number, BlockCorruptionType>();
    const files: ValidatedFile[] = datafiles.map(df => {
      const read = this._ctx.vfs.readFile(df.path);
      const text = read.ok ? new TextDecoder().decode(read.value) : '';
      const defaut = datafileFault(this._ctx.vfs, df, checkLogical);
      if (defaut !== null) defauts.set(df.fileNo, defaut);
      const blocksExamined = Math.max(1, Math.ceil(df.sizeBytes / blockSize));
      const blocksUsed = Math.min(blocksExamined, Math.ceil(text.length / blockSize));
      return {
        fileNo: df.fileNo, path: df.path,
        status: defaut === null ? 'OK' : 'FAILED',
        markedCorrupt: defaut === null ? 0 : blocksExamined,
        emptyBlocks: defaut === null ? blocksExamined - blocksUsed : 0,
        blocksExamined, highScn,
      };
    });
    this._bus.emit({ type: 'VALIDATION_REPORT', jobId: job.id, files, elapsedMs: 1_000 });
    let corrompus = 0;
    for (const f of files) {
      const defaut = defauts.get(f.fileNo);
      if (defaut === undefined) continue;
      corrompus++;
      this._ctx.recordBlockCorruption?.(f.fileNo, f.blocksExamined, defaut);
    }
    if (corrompus > 0) {
      this._bus.emit({
        type: 'PROGRESS_UPDATED', jobId: job.id, stepName: 'validate_corrupt', pct: 95,
        message: 'validate found one or more corrupt blocks',
      });
    }
    return ok(undefined);
  }

  private _validateBackupset(job: RmanJob, bsKey?: string): Result<void, RmanError> {
    const snap = this._catalog.listAll();
    if (snap.ok === false) return snap;
    const wanted = bsKey === undefined ? undefined : Number(bsKey);
    const sets = snap.value.sets.filter(s => wanted === undefined || s.bsKey === wanted);
    if (sets.length === 0) {
      return err({ code: 'RMAN_06004', message: `backupset ${bsKey ?? '?'} not found in catalog` });
    }
    for (const set of sets) {
      for (const piece of set.pieces) {
        const verdict = validateBackupPiece(this._ctx.vfs, piece.path);
        if (verdict.fault !== null) {
          return err({ code: 'ERROR_STACK', message: pieceFaultMessage(verdict) });
        }
        this._bus.emit({
          type: 'PROGRESS_UPDATED', jobId: job.id, stepName: 'validate_piece', pct: 80,
          message: `channel ORA_DISK_1: backup piece ${piece.path}`,
        });
      }
    }
    this._bus.emit({ type: 'VALIDATION_REPORT', jobId: job.id, files: [], elapsedMs: 1_000 });
    return ok(undefined);
  }

  private _copiesOfTag(tag: RmanTag): ReadonlyArray<BackupSet> {
    const snap = this._catalog.listAll();
    if (snap.ok === false) return [];
    return snap.value.sets.filter(s =>
      s.type === 'DATAFILECOPY' && s.tag.label.toUpperCase() === tag.label.toUpperCase());
  }

  private _doRecoverCopy(job: RmanJob): Result<void, RmanError> {
    const params = job.params ?? {};
    const etiquette = params.tag;
    const fileFilter = params.fileNo === undefined ? undefined : Number(params.fileNo);
    const snap = this._catalog.listAll();
    if (snap.ok === false) return snap;
    const copies = snap.value.sets.filter(s => {
      if (s.type !== 'DATAFILECOPY') return false;
      if (etiquette && s.tag.label.toUpperCase() !== etiquette.toUpperCase()) return false;
      if (fileFilter !== undefined) return s.datafiles[0]?.fileNo === fileFilter;
      return true;
    });
    if (copies.length === 0) {
      for (const df of this._ctx.getDatafiles()) {
        if (fileFilter !== undefined && df.fileNo !== fileFilter) continue;
        this._bus.emit({
          type: 'PROGRESS_UPDATED', jobId: job.id, stepName: 'no_copy', pct: 40,
          message: `no copy of datafile ${df.fileNo} found to recover`,
        });
      }
      return ok(undefined);
    }
    const increments = snap.value.sets.filter(s =>
      s.type === 'INCREMENTAL_1'
      && (!etiquette || s.tag.label.toUpperCase() === etiquette.toUpperCase()));
    if (increments.length === 0) {
      this._bus.emit({
        type: 'PROGRESS_UPDATED', jobId: job.id, stepName: 'no_increment', pct: 40,
        message: 'no incremental backup found to apply to the copies',
      });
      return ok(undefined);
    }
    const images = this._readPieceImages(increments);
    for (const copie of copies) {
      const entree = copie.datafiles[0];
      if (entree === undefined) continue;
      const image = images[entree.path];
      if (image === undefined) continue;
      this._bus.emit({
        type: 'PROGRESS_UPDATED', jobId: job.id, stepName: 'apply_increment', pct: 60,
        message: 'channel ORA_DISK_1: starting incremental datafile backup set restore\n'
          + `destination for restore of datafile ${String(entree.fileNo).padStart(5, '0')}: `
          + `${copie.pieces[0].path}`,
      });
      const corps = renderBackupPieceImage(
        `[ORACLE RMAN DATAFILE COPY - ${copie.sizeBytes} bytes]`,
        { datafiles: { [entree.path]: image }, scn: this._ctx.getCurrentScn?.() },
      );
      const ecrit = this._ctx.vfs.writeFile(
        copie.pieces[0].path, new TextEncoder().encode(corps), copie.sizeBytes);
      if (ecrit.ok === false) return ecrit;
      this._bus.emit({
        type: 'PROGRESS_UPDATED', jobId: job.id, stepName: 'applied', pct: 80,
        message: 'channel ORA_DISK_1: datafile copy complete, elapsed time: 00:00:01',
      });
    }
    return ok(undefined);
  }

  private _doBlockRecover(job: RmanJob): Result<void, RmanError> {
    const etat = this._ctx.getInstanceState?.();
    if (etat === 'SHUTDOWN' || etat === 'NOMOUNT') {
      return err({ code: 'RMAN_06403', message: 'database must be mounted or open' });
    }
    const params = job.params ?? {};
    const registre = this._ctx.getBlockCorruptions?.() ?? [];
    const cibles = params.blockScope === 'CORRUPTION_LIST'
      ? registre
      : [{ fileNo: Number(params.fileNo), blocks: 1 }];
    if (cibles.length === 0) {
      this._bus.emit({
        type: 'PROGRESS_UPDATED', jobId: job.id, stepName: 'no_corruption', pct: 50,
        message: 'no corrupt blocks to recover',
      });
      return ok(undefined);
    }
    const snap = this._catalog.listAll();
    if (snap.ok === false) return snap;
    const utilisables = snap.value.sets.filter(set =>
      set.pieces.every(p => validateBackupPiece(this._ctx.vfs, p.path).fault === null));
    if (utilisables.length === 0) {
      const premier = cibles[0]?.fileNo ?? 1;
      return err({
        code: 'ERROR_STACK',
        message: 'RMAN-06026: some targets not found - aborting restore\n'
          + `RMAN-06023: no backup or copy of datafile ${premier} found to restore`,
      });
    }
    const images = this._readPieceImages(utilisables);
    const parNumero = new Map(this._ctx.getDatafiles().map(df => [df.fileNo, df]));
    const source = utilisables[utilisables.length - 1].pieces[0].path;
    for (const cible of cibles) {
      const df = parNumero.get(cible.fileNo);
      if (df === undefined) {
        return err({
          code: 'ERROR_STACK',
          message: `RMAN-06023: no backup or copy of datafile ${cible.fileNo} found to restore`,
        });
      }
      const image = images[df.path];
      if (image === undefined) {
        return err({
          code: 'ERROR_STACK',
          message: `RMAN-06023: no backup or copy of datafile ${cible.fileNo} found to restore`,
        });
      }
      const written = this._ctx.vfs.writeFile(df.path, new TextEncoder().encode(image));
      if (written.ok === false) return written;
      this._bus.emit({
        type: 'BLOCK_RESTORED', jobId: job.id,
        fileNo: cible.fileNo, blocks: cible.blocks, from: source,
      });
      this._ctx.clearBlockCorruption?.(cible.fileNo);
    }
    this._applyArchivedLogs(this._archivedLogs().map(l => l.path));
    return ok(undefined);
  }

  private _doCrosscheck(job?: RmanJob): Result<void, RmanError> {
    const scope = (job?.params?.scope ?? 'BACKUP').toUpperCase();
    const snap = this._catalog.listAll();
    if (snap.ok === false) return snap;
    let available = 0, expired = 0;
    for (const p of snap.value.pieces) {
      const set = snap.value.sets.find(s => s.bsKey === p.bsKey);
      if (scope === 'ARCHIVELOG' && set?.type !== 'ARCHIVELOG') continue;
      if (scope === 'BACKUP'     && set?.type === 'ARCHIVELOG') continue;
      const intacte = validateBackupPiece(this._ctx.vfs, p.path).fault === null;
      if (intacte) available++;
      else { this._catalog.expirePiece(p.key); expired++; }
      this._bus.emit({
        type: 'CROSSCHECK_PIECE', jobId: job?.id ?? '',
        kind: scope === 'ARCHIVELOG' ? 'archived log' : 'backup piece',
        status: intacte ? 'AVAILABLE' : 'EXPIRED',
      });
    }
    this._bus.emit({ type: 'CROSSCHECK_DONE', available, expired });
    return ok(undefined);
  }

  private _doDeleteExpired(): Result<void, RmanError> {
    const expired = this._catalog.listExpired();
    if (expired.ok === false) return expired;
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
