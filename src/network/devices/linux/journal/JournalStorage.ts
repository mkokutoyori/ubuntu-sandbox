import { JournalFileSet, JournalFull, type FileIdentity, type JournalFile, type SeqnumCounter } from './JournalFileSet';
import { resolveJournalMetrics, type ResolvedMetrics } from './JournalMetrics';
import { planVacuum, type VacuumCandidate, type VacuumLimits } from './JournalVacuum';
import { uidForSystemJournal, type JournaldSettings } from './JournaldServer';
import { type JournalFileInfo, type VacuumResult, type VacuumSpec } from './JournalctlTool';
import { type JournalRecord } from './JournalRecord';

const DEFAULT_COMPRESS_THRESHOLD = 512;
const MIN_COMPRESS_THRESHOLD = 8;
const RECHECK_SPACE_USEC = 30_000_000;
const LOG_CRIT = 2;
const RETENTION_PASSES_MAX = 8;

export interface StorageHost {
  nowUsec(): number;
  monotonicUsec(): number;
  directory(): string;
  persistent(): boolean;
  trustedClock(): boolean;
  filesystem(): { sizeBytes: number; availableBytes: number };
  fileIds(stem: string, serial: number): { fileId: string; seqnumId: string; machineId: string };
  filesChanged(): void;
  schedule?(delayMs: number, callback: () => void): () => void;
  announceSpace?(space: SpaceInfo): void;
}

export interface SpaceInfo {
  readonly name: string;
  readonly path: string;
  readonly vfsUsed: number;
  readonly vfsAvailable: number;
  readonly limit: number;
  readonly available: number;
  readonly metrics: ResolvedMetrics;
}

interface Writer {
  readonly stem: string;
  readonly set: JournalFileSet;
}

interface SpaceCache {
  timestamp: number;
  vfsUsed: number;
  vfsAvailable: number;
  limit: number;
  available: number;
}

type MutableLimits = { maxSize: number; minSize: number; keepFree: number; freeBytes: () => number };

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export class JournalStorage {
  private readonly writers = new Map<number, Writer>();
  private retired: JournalFileSet[] = [];
  private readonly seqnum: SeqnumCounter;
  private readonly limits: MutableLimits;
  private metrics: ResolvedMetrics;
  private space: SpaceCache | null = null;
  private serial = 0;
  private lastRealtimeClock = 0;
  private syncScheduled = false;
  private cancelSync: (() => void) | null = null;
  private cancelRetention: (() => void) | null = null;
  private checkingRetention = false;
  private sizeSignature = '';
  oldestFileUsec = 0;

  constructor(private readonly host: StorageHost, private readonly settings: () => JournaldSettings, firstSeqnum = 1) {
    this.seqnum = { next: firstSeqnum };
    this.metrics = this.resolve();
    this.limits = { maxSize: this.metrics.maxSize, minSize: this.metrics.minSize, keepFree: this.metrics.keepFree, freeBytes: () => this.host.filesystem().availableBytes };
    this.open(0);
    this.patchMinUse();
  }

  private resolve(): ResolvedMetrics {
    const settings = this.settings();
    const raw = this.host.persistent() ? settings.systemMetrics : settings.runtimeMetrics;
    return resolveJournalMetrics(raw, this.host.filesystem().sizeBytes);
  }

  reconfigure(): void {
    this.sync();
    this.metrics = this.resolve();
    Object.assign(this.limits, { maxSize: this.metrics.maxSize, minSize: this.metrics.minSize, keepFree: this.metrics.keepFree });
    this.space = null;
    this.patchMinUse();
    this.checkRetention();
  }

  patchMinUse(): void {
    this.refreshSpace();
    this.metrics.minUse = Math.max(this.metrics.minUse, (this.space as SpaceCache).vfsUsed);
  }

  private identity(stem: string): FileIdentity {
    const ids = this.host.fileIds(stem, this.serial++);
    const compress = this.settings().compress;
    return {
      path: `${this.host.directory()}/${stem}.journal`, ...ids, limits: this.limits, createdUsec: this.host.nowUsec(),
      compress: { enabled: compress.enabled, thresholdBytes: compress.thresholdBytes === null ? DEFAULT_COMPRESS_THRESHOLD : Math.max(MIN_COMPRESS_THRESHOLD, compress.thresholdBytes) },
    };
  }

  private open(uid: number): Writer | null {
    const stem = uid === 0 ? 'system' : `user-${uid}`;
    try {
      const set = new JournalFileSet(() => this.identity(stem), this.seqnum);
      const writer = { stem, set };
      this.writers.set(uid, writer);
      return writer;
    } catch (error) {
      if (error instanceof JournalFull) return null;
      throw error;
    }
  }

  private findJournal(uid: number): Writer | null {
    if (this.settings().storage === 'none') return null;
    const key = this.host.persistent() && !uidForSystemJournal(uid) ? uid : 0;
    const existing = this.writers.get(key);
    if (existing !== undefined) return existing;
    const opened = this.open(key);
    if (opened === null && key !== 0) return this.writers.get(0) ?? this.open(0);
    return opened;
  }

  private allSets(): JournalFileSet[] {
    return [...[...this.writers.keys()].sort((a, b) => a - b).map((uid) => (this.writers.get(uid) as Writer).set), ...this.retired];
  }

  private allFiles(): JournalFile[] {
    return this.allSets().flatMap((set) => [...set.all]);
  }

  private append(writer: Writer, items: Uint8Array[], realtimeUsec: number, monotonicUsec: number, bootId: string): JournalRecord | null {
    try {
      return writer.set.append(items, realtimeUsec, monotonicUsec, bootId);
    } catch (error) {
      if (error instanceof JournalFull) return null;
      throw error;
    }
  }

  write(items: Uint8Array[], priority: number, uid: number, realtimeUsec: number, monotonicUsec: number, bootId: string): JournalRecord | null {
    const trusted = this.host.trustedClock();
    let rotate = false;
    let writer: Writer | null = null;
    if (trusted && realtimeUsec < this.lastRealtimeClock) rotate = true;
    else {
      writer = this.findJournal(uid);
      if (writer === null) return null;
      if (writer.set.current.rotateSuggested(this.settings().maxFileUsec, this.host.nowUsec())) rotate = true;
    }
    let vacuumed = false;
    if (rotate) {
      this.rotate();
      this.vacuum(false);
      vacuumed = true;
      writer = this.findJournal(uid);
      if (writer === null) return null;
    }
    if (trusted) this.lastRealtimeClock = realtimeUsec;
    let record = this.append(writer as Writer, items, realtimeUsec, monotonicUsec, bootId);
    if (record === null && !vacuumed) {
      this.rotate();
      this.vacuum(false);
      writer = this.findJournal(uid);
      if (writer !== null) record = this.append(writer, items, realtimeUsec, monotonicUsec, bootId);
    }
    if (record !== null) this.scheduleSync(priority);
    this.announceFileChanges();
    this.checkRetention();
    return record;
  }

  private announceFileChanges(): void {
    const signature = this.allFiles().map((file) => `${file.path}:${file.fileSize}`).join('|');
    if (signature === this.sizeSignature) return;
    this.sizeSignature = signature;
    this.host.filesChanged();
  }

  rotate(): void {
    for (const [uid, writer] of [...this.writers]) {
      try {
        writer.set.rotate();
      } catch (error) {
        if (!(error instanceof JournalFull)) throw error;
        this.writers.delete(uid);
        this.retired.push(writer.set);
      }
    }
    this.announceFileChanges();
  }

  fullRotate(): void {
    this.rotate();
    this.vacuum(true);
    this.patchMinUse();
  }

  private refreshSpace(): SpaceCache {
    const ts = this.host.monotonicUsec();
    if (this.space !== null && this.space.timestamp !== 0 && this.space.timestamp + RECHECK_SPACE_USEC > ts) return this.space;
    const vfsUsed = this.allFiles().reduce((sum, file) => sum + file.fileSize, 0);
    const vfsAvailable = this.host.filesystem().availableBytes;
    const room = Math.max(0, vfsAvailable - this.metrics.keepFree);
    const limit = Math.min(Math.max(vfsUsed + room, this.metrics.minUse), this.metrics.maxUse);
    this.space = { timestamp: ts, vfsUsed, vfsAvailable, limit, available: Math.max(0, limit - vfsUsed) };
    return this.space;
  }

  spaceInfo(): SpaceInfo {
    const space = this.refreshSpace();
    const persistent = this.host.persistent();
    return {
      name: persistent ? 'System Journal' : 'Runtime Journal', path: this.host.directory(), vfsUsed: space.vfsUsed, vfsAvailable: space.vfsAvailable,
      limit: space.limit, available: space.available, metrics: this.metrics,
    };
  }

  availableBytes(): number {
    return this.refreshSpace().available;
  }

  private candidates(): { archived: Array<VacuumCandidate & { file: JournalFile; set: JournalFileSet }>; active: { files: number; usage: number } } {
    const archived: Array<VacuumCandidate & { file: JournalFile; set: JournalFileSet }> = [];
    const active = { files: 0, usage: 0 };
    for (const set of this.allSets()) {
      for (const file of set.all) {
        if (file.state !== 'ARCHIVED') {
          active.files++;
          active.usage += file.fileSize;
          continue;
        }
        const head = file.records[0];
        const named = head?.realtimeUsec ?? 0;
        archived.push({
          name: baseName(file.path), usage: file.fileSize, realtime: Math.min(named, file.createdUsec), seqnumId: file.identity.seqnumId, seqnum: head?.seqnum ?? 0,
          empty: file.records.length === 0, file, set,
        });
      }
    }
    return { archived, active };
  }

  private applyVacuum(limits: VacuumLimits): { deleted: Array<{ name: string; bytes: number; empty: boolean }>; freed: number; oldestKeptRealtime: number | null } {
    const { archived, active } = this.candidates();
    const plan = planVacuum(archived, active, limits, this.host.nowUsec());
    for (const entry of plan.deleted) {
      const doomed = archived.find((candidate) => candidate.name === entry.name);
      if (doomed !== undefined) doomed.set.delete(doomed.file);
    }
    this.retired = this.retired.filter((set) => set.all.length > 0);
    this.announceFileChanges();
    return { deleted: plan.deleted.map((entry) => ({ name: entry.name, bytes: entry.usage, empty: entry.empty })), freed: plan.freed, oldestKeptRealtime: plan.oldestKeptRealtime };
  }

  vacuum(verbose: boolean): void {
    this.oldestFileUsec = 0;
    const space = this.refreshSpace();
    if (verbose) this.host.announceSpace?.(this.spaceInfo());
    const outcome = this.applyVacuum({ maxUse: space.limit, maxFiles: this.metrics.maxFiles, maxRetentionUsec: this.settings().maxRetentionUsec });
    if (outcome.oldestKeptRealtime !== null) this.oldestFileUsec = outcome.oldestKeptRealtime;
    this.space = null;
    this.checkRetention();
  }

  vacuumDirectory(spec: VacuumSpec): VacuumResult[] {
    const outcome = this.applyVacuum({ maxUse: spec.size, maxFiles: spec.files, maxRetentionUsec: spec.time });
    return [{ directory: this.host.directory(), deleted: outcome.deleted, freedBytes: outcome.freed }];
  }

  private checkRetention(): void {
    if (this.checkingRetention) return;
    this.checkingRetention = true;
    try {
      this.cancelRetention?.();
      this.cancelRetention = null;
      for (let pass = 0; pass < RETENTION_PASSES_MAX; pass++) {
        const retention = this.settings().maxRetentionUsec;
        if (retention <= 0 || this.oldestFileUsec <= 0) return;
        const now = this.host.nowUsec();
        const due = this.oldestFileUsec + retention;
        if (due < now) {
          this.rotate();
          this.vacuum(false);
          continue;
        }
        if (this.host.schedule !== undefined) this.cancelRetention = this.host.schedule(Math.ceil((due - now) / 1000) + 1, () => this.checkRetention());
        return;
      }
    } finally {
      this.checkingRetention = false;
    }
  }

  private scheduleSync(priority: number): void {
    if ((priority & 7) <= LOG_CRIT) {
      this.sync();
      return;
    }
    const interval = this.settings().syncIntervalUsec;
    if (this.syncScheduled || interval <= 0 || this.host.schedule === undefined) return;
    this.syncScheduled = true;
    this.cancelSync = this.host.schedule(Math.ceil(interval / 1000), () => this.sync());
  }

  sync(): void {
    for (const set of this.allSets()) if (!set.isRetired) set.current.sync();
    this.cancelSync?.();
    this.cancelSync = null;
    this.syncScheduled = false;
  }

  fileInfos(): JournalFileInfo[] {
    return this.allFiles().map((file) => file.info({ rotateSuggested: file.rotateSuggested(0, 0) }));
  }

  records(): readonly JournalRecord[] {
    const sets = this.allSets();
    const records = sets.flatMap((set) => set.records());
    return sets.length > 1 ? records.sort((a, b) => a.seqnum - b.seqnum) : records;
  }

  usageBytes(): number {
    return this.allFiles().reduce((sum, file) => sum + file.fileSize, 0);
  }

  get seqnumId(): string {
    return (this.writers.get(0) as Writer).set.current.identity.seqnumId;
  }
}
