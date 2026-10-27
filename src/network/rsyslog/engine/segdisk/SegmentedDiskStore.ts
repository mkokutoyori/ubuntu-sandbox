import type { FileHandle, OpenFileOptions, RsyslogFiles } from '../Host';
import { imageOf, messageOf, type MessageCodecContext } from '../MessageCodec';
import type { LoadedBacklog, QueuePosition, QueueStore } from '../QueueStore';
import type { RsyslogMessage } from '../../Message';
import { RS_RET } from '../Log';
import { get16, get32, get64, put16, put32, put64 } from './Bytes';
import { crc32c } from './Crc32c';
import { decodeImage, encodeImage, MAX_PAYLOAD, RecordCodecError } from './RecordCodec';
import {
  CODEC_VERSION, encodeSlot, selectSlot, STATE_FILE_LENGTH, STATE_FLAG_DEMATERIALIZING, STATE_FLAG_RECOVERY, STATE_SLOT_LENGTH,
  type StateImage,
} from './StateSlot';

const SEGMENT_MAGIC = 'RSSEGH02';
const RECORD_MAGIC = 'RSRECD02';
const FOOTER_MAGIC = 'RSSEAL02';
const STORE_VERSION = 2;
const SEGMENT_HEADER_LENGTH = 52;
const RECORD_HEADER_LENGTH = 32;
const FOOTER_LENGTH = 48;
const RECOVERY_SCAN_BUDGET = 1024 * 1024;
const SUFFIXES = ['seg', 'recover', 'open'] as const;
const OPEN_OPTIONS: OpenFileOptions = {
  mode: 0o600, directoryMode: 0o700, uid: null, gid: null, directoryUid: null, directoryGid: null, createDirectories: false, failOnChownFailure: false,
};

export type StoreStatus = 'ok' | 'io' | 'invalid' | 'missing' | 'nodata' | 'retry' | 'toolarge';

export interface SegmentedDiskConfig {
  readonly directory: string;
  readonly prefix: string;
  readonly queueName: string;
  readonly maxFileSize: number;
  readonly maxDiskSpace: number;
  readonly checkpointInterval: number;
  readonly lazyCreate: boolean;
}

export interface SegmentedDiskEnvironment {
  readonly files: RsyslogFiles;
  readonly codec: () => MessageCodecContext;
  readonly random: () => number;
  readonly report: (severity: number, code: number, text: string) => void;
  readonly beforeMaterialize?: () => boolean;
}

export interface SegmentedDiskStatistics {
  bytes: number;
  segments: number;
  checkpoints: number;
  replayed: number;
  corruptionEvents: number;
  corruptionBytes: number;
  corruptionRecords: number;
  retryOverageBytes: number;
  retryOverageMaxBytes: number;
  stateWrites: number;
  forcedStateWrites: number;
  recoveryBytes: number;
  recoveryRecords: number;
  startupPayloadBytesRead: number;
  startupSegmentFilesProbed: number;
  recoveryPending: number;
  corruptionSegments: number;
  materializations: number;
  dematerializations: number;
  idleCleanupFailures: number;
}

interface Segment {
  id: number;
  firstSequence: number;
  lastSequence: number;
  recordCount: number;
  dataEnd: number;
  fileSize: number;
  rollingCrc: number;
  sealed: boolean;
  recovery: boolean;
  path: string;
}

interface Discovered {
  readonly message: RsyslogMessage;
  readonly position: QueuePosition;
}

function emptyStatistics(): SegmentedDiskStatistics {
  return {
    bytes: 0, segments: 0, checkpoints: 0, replayed: 0, corruptionEvents: 0, corruptionBytes: 0, corruptionRecords: 0,
    retryOverageBytes: 0, retryOverageMaxBytes: 0, stateWrites: 0, forcedStateWrites: 0, recoveryBytes: 0, recoveryRecords: 0,
    startupPayloadBytesRead: 0, startupSegmentFilesProbed: 0, recoveryPending: 0, corruptionSegments: 0, materializations: 0,
    dematerializations: 0, idleCleanupFailures: 0,
  };
}

function newSegment(id: number, path: string): Segment {
  return { id, firstSequence: 1, lastSequence: 0, recordCount: 0, dataEnd: 0, fileSize: 0, rollingCrc: 0, sealed: false, recovery: false, path };
}

export function segmentFileName(id: number, suffix: string): string {
  return `segment-${String(id).padStart(20, '0')}.${suffix}`;
}

function segmentNameOf(name: string): boolean {
  return /^segment-\d{1,20}\.(seg|open|recover)$/.test(name);
}

export class SegmentedDiskStore implements QueueStore {
  readonly managesCheckpoints = true;
  readonly stats = emptyStatistics();
  private readonly directory: string;
  private readonly positions = new WeakMap<object, QueuePosition>();
  private materialized = false;
  private uuid = '';
  private generation = 0;
  private committedSegment = 0;
  private committedRecordSequence = 0;
  private committedOffset = SEGMENT_HEADER_LENGTH;
  private firstLiveSegment = 0;
  private lastDataSegment = 0;
  private activeSegment = 0;
  private recoveryFirst = 0;
  private recoveryLast = 0;
  private nextSegment = 1;
  private persistedQueueSize = 0;
  private persistedWriterSegment = 0;
  private persistedWriterEnd = SEGMENT_HEADER_LENGTH;
  private persistedWriterSequence = 0;
  private persistedWriterCount = 0;
  private deleteFirst = 0;
  private deleteLast = 0;
  private deleteBytes = 0;
  private deleteSegments = 0;
  private discoveryThroughSegment = 0;
  private readSegmentId = 0;
  private readOffset = SEGMENT_HEADER_LENGTH;
  private readSegment: Segment | null = null;
  private active: Segment | null = null;
  private activeHandle: FileHandle | null = null;
  private knownQueueSize = 0;
  private updatesSinceCheckpoint = 0;
  private dematerializing = false;
  private nextIndex = 0;
  private committedIndex = 0;
  private segmentEnds = new Map<number, number>();

  constructor(
    private readonly config: SegmentedDiskConfig,
    private readonly environment: SegmentedDiskEnvironment,
  ) {
    this.directory = `${config.directory}/${config.prefix}.segq`;
  }

  get infoFile(): string {
    return `${this.directory}/state`;
  }

  get isMaterialized(): boolean {
    return this.materialized;
  }

  get statistics(): Readonly<SegmentedDiskStatistics> {
    return this.stats;
  }

  private get files(): RsyslogFiles {
    return this.environment.files;
  }

  private error(code: number, text: string): void {
    this.environment.report(3, code, `${this.config.queueName}: ${text}`);
  }

  private path(id: number, suffix: string): string {
    return `${this.directory}/${segmentFileName(id, suffix)}`;
  }

  private statePath(): string {
    return `${this.directory}/state`;
  }

  positionOf(item: object): QueuePosition | undefined {
    return this.positions.get(item);
  }

  exceedsDiskSpace(): boolean {
    return this.config.maxDiskSpace !== 0 && this.stats.bytes >= this.config.maxDiskSpace;
  }

  takePendingPersist(): boolean {
    return false;
  }

  private randomUuid(): string {
    const bytes: number[] = [];
    for (let index = 0; index < 16; index++) bytes.push(Math.floor(this.environment.random() * 256) & 0xff);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return String.fromCharCode(...bytes);
  }

  private image(): StateImage {
    return {
      uuid: this.uuid,
      generation: this.generation,
      flags: (this.recoveryFirst !== 0 ? STATE_FLAG_RECOVERY : 0) | (this.dematerializing ? STATE_FLAG_DEMATERIALIZING : 0),
      committedSegment: this.committedSegment,
      committedOffset: this.committedOffset,
      committedRecordSequence: this.committedRecordSequence,
      firstLiveSegment: this.firstLiveSegment,
      lastDataSegment: this.lastDataSegment,
      activeSegment: this.activeSegment,
      recoveryFirst: this.recoveryFirst,
      recoveryLast: this.recoveryLast,
      nextSegment: this.nextSegment,
      knownQueueSize: this.knownQueueSize,
      bytes: this.stats.bytes,
      segments: this.stats.segments,
      writerSegment: this.persistedWriterSegment,
      writerEnd: this.persistedWriterEnd,
      writerSequence: this.persistedWriterSequence,
      writerCount: this.persistedWriterCount,
      deleteFirst: this.deleteFirst,
      deleteLast: this.deleteLast,
      deleteBytes: this.deleteBytes,
      deleteSegments: this.deleteSegments,
    };
  }

  private applyImage(state: StateImage): void {
    this.uuid = state.uuid;
    this.generation = state.generation;
    this.dematerializing = (state.flags & STATE_FLAG_DEMATERIALIZING) !== 0;
    this.committedSegment = state.committedSegment;
    this.committedOffset = state.committedOffset;
    this.committedRecordSequence = state.committedRecordSequence;
    this.firstLiveSegment = state.firstLiveSegment;
    this.lastDataSegment = state.lastDataSegment;
    this.activeSegment = state.activeSegment;
    this.recoveryFirst = state.recoveryFirst;
    this.recoveryLast = state.recoveryLast;
    this.nextSegment = state.nextSegment;
    this.persistedQueueSize = state.knownQueueSize;
    this.stats.bytes = state.bytes;
    this.stats.segments = Math.min(state.segments, 0x7fffffff);
    this.persistedWriterSegment = state.writerSegment;
    this.persistedWriterEnd = state.writerEnd;
    this.persistedWriterSequence = state.writerSequence;
    this.persistedWriterCount = state.writerCount;
    this.deleteFirst = state.deleteFirst;
    this.deleteLast = state.deleteLast;
    this.deleteBytes = state.deleteBytes;
    this.deleteSegments = state.deleteSegments;
  }

  private pwriteState(slotIndex: number, slot: string): boolean {
    const content = this.files.read(this.statePath());
    if (content === null) return false;
    const offset = slotIndex * STATE_SLOT_LENGTH;
    return this.files.write(this.statePath(), content.slice(0, offset) + slot + content.slice(offset + slot.length));
  }

  private writeState(forceSync: boolean, topology: boolean): StoreStatus {
    const next = this.generation + 1;
    const slot = encodeSlot(this.image(), next);
    if (!this.pwriteState(next & 1, slot)) return 'io';
    this.generation = next;
    this.stats.checkpoints++;
    this.stats.stateWrites++;
    if (forceSync || topology) this.stats.forcedStateWrites++;
    this.updatesSinceCheckpoint = 0;
    return 'ok';
  }

  private readState(): StoreStatus {
    const content = this.files.read(this.statePath());
    if (content === null) return 'io';
    const slot0 = content.length >= STATE_SLOT_LENGTH ? content.slice(0, STATE_SLOT_LENGTH) : null;
    const slot1 = content.length >= 2 * STATE_SLOT_LENGTH ? content.slice(STATE_SLOT_LENGTH, 2 * STATE_SLOT_LENGTH) : null;
    const selected = selectSlot(slot0, slot1);
    if (selected === null) return 'invalid';
    const state = selected.state;
    if ((state.flags & ~(STATE_FLAG_RECOVERY | STATE_FLAG_DEMATERIALIZING)) !== 0
      || (state.deleteFirst === 0) !== (state.deleteLast === 0)
      || (state.deleteFirst !== 0 && state.deleteFirst > state.deleteLast) || state.deleteBytes < 0) return 'invalid';
    this.applyImage(state);
    return 'ok';
  }

  private segmentHeader(id: number): string {
    const body = SEGMENT_MAGIC + put16(STORE_VERSION) + put16(CODEC_VERSION) + this.uuid + put64(id) + put64(1) + put32(SEGMENT_HEADER_LENGTH);
    return body + put32(crc32c(body));
  }

  private validateSegmentHeader(content: string, segment: Segment): boolean {
    if (content.length < SEGMENT_HEADER_LENGTH) return false;
    const head = content.slice(0, SEGMENT_HEADER_LENGTH);
    if (!head.startsWith(SEGMENT_MAGIC) || get16(head, 8) !== STORE_VERSION || get16(head, 10) !== CODEC_VERSION
      || head.slice(12, 28) !== this.uuid || get64(head, 28) !== segment.id || get32(head, 44) !== SEGMENT_HEADER_LENGTH
      || get32(head, 48) !== crc32c(head.slice(0, 48))) return false;
    segment.firstSequence = get64(head, 36);
    return true;
  }

  private probe(id: number, suffix: string): { path: string; size: number } | 'missing' | 'io' {
    const path = this.path(id, suffix);
    const stat = this.files.lstat(path);
    if (stat === null) return 'missing';
    return stat.kind === 'file' ? { path, size: stat.size } : 'io';
  }

  private loadSegment(id: number): Segment | StoreStatus {
    let found: { path: string; size: number } | null = null;
    let sealed = false;
    let recovery = false;
    for (const suffix of ['seg', 'recover', 'open'] as const) {
      const probed = this.probe(id, suffix);
      if (probed === 'missing') continue;
      if (probed === 'io') return 'io';
      found = probed;
      sealed = suffix === 'seg';
      recovery = suffix === 'recover';
      break;
    }
    if (found === null) return 'missing';
    const content = this.files.read(found.path);
    if (content === null) return 'io';
    const segment = newSegment(id, found.path);
    segment.sealed = sealed;
    segment.recovery = recovery;
    let valid = this.validateSegmentHeader(content, segment);
    if (valid && sealed) {
      if (content.length < SEGMENT_HEADER_LENGTH + FOOTER_LENGTH) valid = false;
      else {
        const footer = content.slice(content.length - FOOTER_LENGTH);
        if (!footer.startsWith(FOOTER_MAGIC) || get64(footer, 8) !== id || get32(footer, 44) !== crc32c(footer.slice(0, 44))) valid = false;
        else {
          segment.firstSequence = get64(footer, 16);
          segment.lastSequence = get64(footer, 24);
          segment.recordCount = get64(footer, 32);
          segment.rollingCrc = get32(footer, 40);
          segment.dataEnd = content.length - FOOTER_LENGTH;
        }
      }
    } else if (valid) segment.dataEnd = content.length;
    if (!valid) {
      this.stats.corruptionEvents++;
      this.error(RS_RET.INVALID_VALUE, `segmentedDisk could not validate segment metadata '${found.path}'`);
      return 'invalid';
    }
    segment.fileSize = content.length;
    this.segmentEnds.set(id, segment.dataEnd);
    return segment;
  }

  private captureWriter(): void {
    if (this.active === null) return;
    this.persistedWriterSegment = this.active.id;
    this.persistedWriterEnd = this.active.dataEnd;
    this.persistedWriterSequence = this.active.lastSequence;
    this.persistedWriterCount = this.active.recordCount;
  }

  private createActive(): StoreStatus {
    const oldFirstLive = this.firstLiveSegment;
    const oldNext = this.nextSegment;
    const id = this.nextSegment++;
    const segment = newSegment(id, this.path(id, 'open'));
    segment.dataEnd = SEGMENT_HEADER_LENGTH;
    segment.fileSize = SEGMENT_HEADER_LENGTH;
    this.activeSegment = id;
    if (this.firstLiveSegment === 0) this.firstLiveSegment = id;
    this.stats.segments++;
    this.stats.bytes += SEGMENT_HEADER_LENGTH;
    const rollback = (keepNext: boolean): void => {
      this.activeSegment = 0;
      this.firstLiveSegment = oldFirstLive;
      if (!keepNext) this.nextSegment = oldNext;
      this.stats.segments--;
      this.stats.bytes -= SEGMENT_HEADER_LENGTH;
    };
    if (this.writeState(true, true) !== 'ok') {
      rollback(false);
      return 'io';
    }
    if (this.files.exists(segment.path)) {
      rollback(true);
      return 'io';
    }
    const opened = this.files.open(segment.path, OPEN_OPTIONS);
    if ('error' in opened) {
      rollback(true);
      return 'io';
    }
    if (opened.handle.write(this.segmentHeader(id)) !== null) {
      opened.handle.close();
      this.files.remove(segment.path);
      rollback(true);
      return 'io';
    }
    opened.handle.flush();
    this.active = segment;
    this.activeHandle = opened.handle;
    this.segmentEnds.set(id, SEGMENT_HEADER_LENGTH);
    return 'ok';
  }

  private materializeEmpty(): StoreStatus {
    if (this.materialized) return 'ok';
    if (this.environment.beforeMaterialize !== undefined && !this.environment.beforeMaterialize()) return 'io';
    if (!this.files.mkdir(this.directory, 0o700) && !this.files.isDirectory(this.directory)) return 'io';
    this.materialized = true;
    let status: StoreStatus = 'ok';
    if (!this.files.write(this.statePath(), '\0'.repeat(STATE_FILE_LENGTH))) status = 'io';
    this.uuid = this.randomUuid();
    this.committedOffset = SEGMENT_HEADER_LENGTH;
    this.persistedWriterEnd = SEGMENT_HEADER_LENGTH;
    this.nextSegment = 1;
    if (status === 'ok') status = this.createActive();
    if (status === 'ok') {
      this.stats.materializations++;
      return 'ok';
    }
    this.activeHandle?.close();
    this.activeHandle = null;
    this.active = null;
    this.removeRemainingSegments();
    this.files.remove(this.statePath());
    this.files.rmdir(this.directory);
    this.materialized = false;
    return status;
  }

  open(): { status: StoreStatus; queueSize: number } {
    const qi = `${this.config.directory}/${this.config.prefix}.qi`;
    if (this.files.lstat(qi) !== null) {
      this.error(RS_RET.INVALID_VALUE, `segmentedDisk refuses legacy queue state '${qi}'`);
      return { status: 'invalid', queueSize: 0 };
    }
    if (this.config.lazyCreate && this.files.lstat(this.directory) === null) return { status: 'ok', queueSize: 0 };
    let created = false;
    if (this.files.mkdir(this.directory, 0o700)) created = true;
    else if (!this.files.isDirectory(this.directory)) return { status: 'io', queueSize: 0 };
    this.materialized = true;
    const failed = (status: StoreStatus): { status: StoreStatus; queueSize: number } => {
      this.materialized = false;
      return { status, queueSize: 0 };
    };
    const stateStat = this.files.lstat(this.statePath());
    if (stateStat === null) {
      if (this.files.exists(`${this.directory}/meta`) || this.files.exists(`${this.directory}/checkpoint`)) {
        this.error(RS_RET.INVALID_VALUE, 'experimental segmentedDisk v1 state is incompatible with store format v2; offline recovery is required');
        return failed('invalid');
      }
      if (!created && this.files.list(this.directory).length > 0) {
        this.error(RS_RET.INVALID_VALUE, 'segmentedDisk state is missing while queue files exist; offline recovery is required');
        return failed('invalid');
      }
      if (this.config.lazyCreate && !created) {
        this.files.rmdir(this.directory);
        this.materialized = false;
        return { status: 'ok', queueSize: 0 };
      }
      if (!this.files.write(this.statePath(), '\0'.repeat(STATE_FILE_LENGTH))) return failed('io');
      this.uuid = this.randomUuid();
      if (this.createActive() !== 'ok') return failed('io');
    } else {
      if (stateStat.size !== STATE_FILE_LENGTH) return failed('invalid');
      if (this.readState() !== 'ok') {
        this.error(RS_RET.INVALID_VALUE, 'segmentedDisk has no valid state slot; offline recovery is required');
        return failed('invalid');
      }
      if (this.dematerializing) {
        if (this.finishInterruptedDematerialization() !== 'ok') return failed('io');
        if (this.config.lazyCreate) return { status: 'ok', queueSize: 0 };
        return this.materializeEmpty() === 'ok' ? { status: 'ok', queueSize: 0 } : failed('io');
      }
      if (this.prepareExistingActive() !== 'ok') return failed('io');
      if (this.adoptReservedSegment() !== 'ok') return failed('io');
      this.discoveryThroughSegment = this.lastDataSegment;
      if (this.createActive() !== 'ok') return failed('io');
    }
    this.stats.materializations++;
    this.knownQueueSize = 0;
    this.stats.replayed = this.persistedQueueSize;
    this.readSegmentId = this.committedSegment !== 0 ? this.committedSegment : this.firstLiveSegment;
    if (this.readSegmentId === 0) this.readSegmentId = this.firstLiveSegment;
    this.readOffset = this.committedSegment === this.readSegmentId && this.committedOffset >= SEGMENT_HEADER_LENGTH ? this.committedOffset : SEGMENT_HEADER_LENGTH;
    return { status: 'ok', queueSize: 0 };
  }

  private removeRemainingSegments(): StoreStatus {
    let status: StoreStatus = 'ok';
    for (const name of this.files.list(this.directory)) {
      if (name === 'state') continue;
      if (!segmentNameOf(name)) {
        status = 'io';
        continue;
      }
      if (!this.files.remove(`${this.directory}/${name}`) && this.files.exists(`${this.directory}/${name}`)) status = 'io';
    }
    return status;
  }

  private directoryHasSegments(): boolean {
    return this.files.list(this.directory).some(segmentNameOf);
  }

  private prepareExistingActive(): StoreStatus {
    if (this.activeSegment === 0) return 'ok';
    const accounted = this.persistedWriterSegment === this.activeSegment && this.persistedWriterEnd >= SEGMENT_HEADER_LENGTH ? this.persistedWriterEnd : SEGMENT_HEADER_LENGTH;
    let actual = -1;
    this.stats.startupSegmentFilesProbed++;
    let found = false;
    const openProbe = this.probe(this.activeSegment, 'open');
    if (openProbe !== 'missing' && openProbe !== 'io') {
      actual = openProbe.size;
      if (!this.files.rename(openProbe.path, this.path(this.activeSegment, 'recover'))) return 'io';
      this.markRecovery();
      found = true;
    } else if (openProbe === 'io') return 'io';
    if (!found) {
      this.stats.startupSegmentFilesProbed++;
      const recoverProbe = this.probe(this.activeSegment, 'recover');
      if (recoverProbe === 'io') return 'io';
      if (recoverProbe !== 'missing') {
        actual = recoverProbe.size;
        this.markRecovery();
        found = true;
      }
    }
    if (!found) {
      this.stats.startupSegmentFilesProbed++;
      const sealedProbe = this.probe(this.activeSegment, 'seg');
      if (sealedProbe === 'io') return 'io';
      if (sealedProbe !== 'missing') {
        actual = sealedProbe.size;
        if (this.lastDataSegment < this.activeSegment) this.lastDataSegment = this.activeSegment;
        found = true;
      }
    }
    if (!found) {
      if (this.stats.segments > 0) this.stats.segments--;
      if (this.stats.bytes >= accounted) this.stats.bytes -= accounted;
      if (this.firstLiveSegment === this.activeSegment) this.firstLiveSegment = 0;
    } else if (actual >= 0) this.stats.bytes += actual - accounted;
    this.activeSegment = 0;
    return 'ok';
  }

  private markRecovery(): void {
    if (this.recoveryFirst === 0) this.recoveryFirst = this.activeSegment;
    this.recoveryLast = this.activeSegment;
    if (this.lastDataSegment < this.activeSegment) this.lastDataSegment = this.activeSegment;
  }

  private adoptReservedSegment(): StoreStatus {
    const id = this.nextSegment;
    let foundSuffix: string | null = null;
    let size = 0;
    let foundPath = '';
    for (const suffix of ['open', 'recover', 'seg']) {
      this.stats.startupSegmentFilesProbed++;
      const probed = this.probe(id, suffix);
      if (probed === 'io') return 'io';
      if (probed !== 'missing') {
        foundSuffix = suffix;
        size = probed.size;
        foundPath = probed.path;
        break;
      }
    }
    if (foundSuffix === null) return 'ok';
    if (foundSuffix === 'open' && !this.files.rename(foundPath, this.path(id, 'recover'))) return 'io';
    if (this.firstLiveSegment === 0) this.firstLiveSegment = id;
    if (this.recoveryFirst === 0) this.recoveryFirst = id;
    this.recoveryLast = id;
    if (this.lastDataSegment < id) this.lastDataSegment = id;
    this.stats.segments++;
    this.stats.bytes += size;
    this.nextSegment++;
    return 'ok';
  }

  private resetAfterDematerialize(): void {
    this.uuid = '';
    this.generation = 0;
    this.committedSegment = 0;
    this.committedRecordSequence = 0;
    this.committedOffset = SEGMENT_HEADER_LENGTH;
    this.firstLiveSegment = 0;
    this.lastDataSegment = 0;
    this.activeSegment = 0;
    this.recoveryFirst = 0;
    this.recoveryLast = 0;
    this.nextSegment = 1;
    this.persistedQueueSize = 0;
    this.persistedWriterSegment = 0;
    this.persistedWriterEnd = SEGMENT_HEADER_LENGTH;
    this.persistedWriterSequence = 0;
    this.persistedWriterCount = 0;
    this.deleteFirst = 0;
    this.deleteLast = 0;
    this.deleteBytes = 0;
    this.deleteSegments = 0;
    this.discoveryThroughSegment = 0;
    this.readSegmentId = 0;
    this.readOffset = SEGMENT_HEADER_LENGTH;
    this.readSegment = null;
    this.knownQueueSize = 0;
    this.updatesSinceCheckpoint = 0;
    this.dematerializing = false;
    this.stats.bytes = 0;
    this.stats.segments = 0;
    this.stats.retryOverageBytes = 0;
    this.segmentEnds.clear();
    this.nextIndex = 0;
    this.committedIndex = 0;
  }

  private finishInterruptedDematerialization(): StoreStatus {
    let status = this.removeRemainingSegments();
    if (status === 'ok' && !this.files.remove(this.statePath()) && this.files.exists(this.statePath())) status = 'io';
    if (status === 'ok' && !this.files.rmdir(this.directory) && this.files.exists(this.directory)) status = 'io';
    if (status !== 'ok') return status;
    this.materialized = false;
    this.resetAfterDematerialize();
    this.stats.dematerializations++;
    return 'ok';
  }

  private makeRecord(message: RsyslogMessage, sequence: number): { bytes: string; rolling: number } | StoreStatus {
    let payload: string;
    try {
      payload = encodeImage(imageOf(message, this.environment.codec()));
    } catch (failure) {
      return failure instanceof RecordCodecError ? 'toolarge' : 'io';
    }
    if (payload.length > MAX_PAYLOAD) return 'toolarge';
    const head = RECORD_MAGIC + put16(STORE_VERSION) + '\0\0' + put32(payload.length) + put64(sequence);
    const headerCrc = crc32c(head);
    const payloadCrc = crc32c(payload);
    const header = head + put32(headerCrc) + put32(payloadCrc);
    return { bytes: header + payload, rolling: (crc32c(header) ^ payloadCrc) >>> 0 };
  }

  private updateRetryOverage(): void {
    this.stats.retryOverageBytes = this.config.maxDiskSpace > 0 && this.stats.bytes > this.config.maxDiskSpace ? this.stats.bytes - this.config.maxDiskSpace : 0;
    if (this.stats.retryOverageBytes > this.stats.retryOverageMaxBytes) this.stats.retryOverageMaxBytes = this.stats.retryOverageBytes;
  }

  private restoreActiveAfterSealFailure(): void {
    const active = this.active;
    if (active === null) return;
    const content = this.files.read(active.path);
    if (content === null) return;
    this.files.write(active.path, content.slice(0, active.dataEnd));
    const opened = this.files.open(active.path, OPEN_OPTIONS);
    if (!('error' in opened)) this.activeHandle = opened.handle;
  }

  private sealActive(): StoreStatus {
    const active = this.active;
    if (active === null || active.sealed || active.recordCount === 0) return 'ok';
    const sealedPath = this.path(active.id, 'seg');
    const body = FOOTER_MAGIC + put64(active.id) + put64(active.firstSequence) + put64(active.lastSequence) + put64(active.recordCount) + put32(active.rollingCrc);
    const footer = body + put32(crc32c(body));
    const handle = this.activeHandle as FileHandle;
    const failure = handle.write(footer);
    handle.flush();
    handle.close();
    this.activeHandle = null;
    if (failure !== null) {
      this.restoreActiveAfterSealFailure();
      return 'io';
    }
    if (!this.files.rename(active.path, sealedPath)) {
      this.restoreActiveAfterSealFailure();
      return 'io';
    }
    active.path = sealedPath;
    active.sealed = true;
    active.fileSize += FOOTER_LENGTH;
    active.dataEnd = active.fileSize - FOOTER_LENGTH;
    this.stats.bytes += FOOTER_LENGTH;
    this.lastDataSegment = active.id;
    this.segmentEnds.set(active.id, active.dataEnd);
    if (this.readSegment !== null && this.readSegment.id === active.id) {
      this.readSegment.path = sealedPath;
      this.readSegment.sealed = true;
      this.readSegment.dataEnd = active.dataEnd;
      this.readSegment.fileSize = active.fileSize;
    }
    this.captureWriter();
    this.activeSegment = 0;
    this.active = null;
    return 'ok';
  }

  append(message: RsyslogMessage, internal = false): string | null {
    const outcome = this.appendRecord(message, internal);
    return outcome === 'ok' ? null : `segmentedDisk append failed (${outcome})`;
  }

  private appendRecord(message: RsyslogMessage, internal: boolean): StoreStatus {
    if (!this.materialized) {
      const status = this.materializeEmpty();
      if (status !== 'ok') return status;
    }
    if (this.active === null) {
      const status = this.createActive();
      if (status !== 'ok') return status;
    }
    let active = this.active as Segment;
    let made = this.makeRecord(message, active.recordCount + 1);
    if (typeof made === 'string') return made;
    const rotate = active.recordCount !== 0 && this.config.maxFileSize > 0 && active.fileSize + made.bytes.length + FOOTER_LENGTH > this.config.maxFileSize;
    if (rotate) {
      let status = this.sealActive();
      if (status === 'ok') status = this.createActive();
      if (status !== 'ok') return status;
      active = this.active as Segment;
      made = this.makeRecord(message, 1);
      if (typeof made === 'string') return made;
    }
    const handle = this.activeHandle as FileHandle;
    const failure = handle.write(made.bytes);
    if (failure !== null) return 'io';
    handle.flush();
    active.dataEnd += made.bytes.length;
    active.fileSize += made.bytes.length;
    active.lastSequence = ++active.recordCount;
    active.rollingCrc = (active.rollingCrc ^ made.rolling) >>> 0;
    this.lastDataSegment = active.id;
    this.segmentEnds.set(active.id, active.dataEnd);
    this.knownQueueSize++;
    this.stats.bytes += made.bytes.length;
    this.positions.set(message, { file: active.id, offset: active.dataEnd, sequence: active.lastSequence, index: ++this.nextIndex });
    let status: StoreStatus = 'ok';
    if (active.recordCount === 1 && this.config.maxFileSize > 0 && active.fileSize + FOOTER_LENGTH > this.config.maxFileSize) status = this.sealActive();
    if (status === 'ok' && internal) this.updateRetryOverage();
    return status;
  }

  private segmentIsUndiscovered(id: number): boolean {
    return id !== 0 && id <= this.discoveryThroughSegment;
  }

  private recordAt(segment: Segment, content: string, cursor: { offset: number }, budget: { left: number }, tally: { skipped: number; discovered: number }): Discovered | 'retry' | 'nodata' {
    if (segment.id === this.activeSegment && this.active !== null) segment.dataEnd = this.active.dataEnd;
    while (cursor.offset + RECORD_HEADER_LENGTH <= segment.dataEnd) {
      const header = content.slice(cursor.offset, cursor.offset + RECORD_HEADER_LENGTH);
      const length = get32(header, 12);
      if (!header.startsWith(RECORD_MAGIC) || get16(header, 8) !== STORE_VERSION || get32(header, 24) !== crc32c(header.slice(0, 24))
        || length > MAX_PAYLOAD || cursor.offset + RECORD_HEADER_LENGTH + length > segment.dataEnd) {
        this.stats.corruptionEvents++;
        this.stats.corruptionBytes++;
        this.stats.recoveryBytes++;
        cursor.offset++;
        if (budget.left === 0) return 'retry';
        budget.left--;
        continue;
      }
      const payload = content.slice(cursor.offset + RECORD_HEADER_LENGTH, cursor.offset + RECORD_HEADER_LENGTH + length);
      const sequence = get64(header, 16);
      if (this.segmentIsUndiscovered(segment.id)) {
        tally.discovered++;
        this.knownQueueSize++;
        this.stats.recoveryRecords++;
        this.stats.recoveryBytes += RECORD_HEADER_LENGTH + length;
      }
      cursor.offset += RECORD_HEADER_LENGTH + length;
      const index = ++this.nextIndex;
      let message: RsyslogMessage | null = null;
      if (get32(header, 28) === crc32c(payload)) {
        try {
          message = messageOf(decodeImage(payload), this.environment.codec());
        } catch (failure) {
          if (!(failure instanceof RecordCodecError)) throw failure;
        }
      }
      if (message === null) {
        this.stats.corruptionEvents++;
        this.stats.corruptionRecords++;
        tally.skipped++;
        continue;
      }
      const position = { file: segment.id, offset: cursor.offset, sequence, index };
      this.positions.set(message, position);
      return { message, position };
    }
    if (cursor.offset < segment.dataEnd && segment.id !== this.activeSegment) {
      const tail = segment.dataEnd - cursor.offset;
      this.stats.corruptionBytes += tail;
      this.stats.recoveryBytes += tail;
      cursor.offset = segment.dataEnd;
    }
    return 'nodata';
  }

  load(): LoadedBacklog | null {
    if (!this.materialized) return null;
    const outcome = this.discover();
    return outcome.messages.length === 0 && this.stats.replayed === 0 && outcome.skipped === 0 ? null : { messages: outcome.messages.map((entry) => entry.message), positions: outcome.messages.map((entry) => entry.position) };
  }

  discover(): { messages: Discovered[]; skipped: number } {
    const messages: Discovered[] = [];
    let skippedTotal = 0;
    for (;;) {
      if (this.deleteFirst !== 0) {
        if (this.cleanupOnePendingDelete() !== 'ok') this.error(RS_RET.IO_ERROR, 'segmentedDisk pending segment deletion failed and will be retried');
        if (this.deleteFirst !== 0) break;
      }
      const tally = { skipped: 0, discovered: 0 };
      const budget = { left: RECOVERY_SCAN_BUDGET };
      let consumed = 0;
      let retry = false;
      const content = new Map<number, string>();
      for (;;) {
        if (this.readSegment === null) {
          if (this.readSegmentId === 0) this.readSegmentId = this.firstLiveSegment;
          while (this.readSegmentId !== 0 && this.readSegmentId <= this.lastDataSegment) {
            const loaded = this.loadSegment(this.readSegmentId);
            if (loaded === 'missing') {
              this.stats.corruptionEvents++;
              this.stats.corruptionSegments++;
              this.error(RS_RET.FILE_NOT_FOUND, `segmentedDisk expected segment ${this.readSegmentId} is missing during lazy dequeue; continuing with the next segment`);
              this.readSegmentId++;
              this.readOffset = SEGMENT_HEADER_LENGTH;
              continue;
            }
            if (typeof loaded === 'string') return { messages, skipped: skippedTotal };
            this.readSegment = loaded;
            if (this.committedSegment === this.readSegmentId && this.committedOffset >= SEGMENT_HEADER_LENGTH && this.committedOffset <= loaded.dataEnd) this.readOffset = this.committedOffset;
            else if (this.readOffset < SEGMENT_HEADER_LENGTH) this.readOffset = SEGMENT_HEADER_LENGTH;
            break;
          }
          if (this.readSegment === null) break;
        }
        const segment = this.readSegment;
        let text = content.get(segment.id);
        if (text === undefined) {
          text = this.files.read(segment.path) ?? '';
          content.set(segment.id, text);
        }
        const cursor = { offset: this.readOffset };
        const before = tally.skipped;
        const outcome = this.recordAt(segment, text, cursor, budget, tally);
        this.readOffset = cursor.offset;
        consumed += tally.skipped - before;
        if (outcome === 'retry') {
          this.stats.recoveryPending++;
          retry = true;
          break;
        }
        if (outcome === 'nodata') {
          if (segment.id === this.activeSegment) break;
          this.readSegmentId++;
          this.readOffset = SEGMENT_HEADER_LENGTH;
          this.readSegment = null;
          continue;
        }
        consumed++;
        messages.push(outcome);
      }
      skippedTotal += tally.skipped;
      if (tally.skipped > 0) this.error(RS_RET.ERR, `segmentedDisk salvage skipped ${tally.skipped} corrupt records`);
      if (!retry) break;
    }
    return { messages, skipped: skippedTotal };
  }

  markDequeued(position: QueuePosition): void {
    if (this.readSegment === null || this.readSegment.id !== position.file) {
      this.readSegmentId = position.file;
      const end = this.active !== null && this.active.id === position.file ? this.active.dataEnd : (this.segmentEnds.get(position.file) ?? position.offset);
      this.readSegment = { ...newSegment(position.file, ''), dataEnd: end };
    }
    if (this.active !== null && this.active.id === position.file) this.readSegment.dataEnd = this.active.dataEnd;
    this.readOffset = position.offset;
  }

  private unlinkSegmentId(id: number, account: boolean): StoreStatus {
    for (const suffix of SUFFIXES) {
      const path = this.path(id, suffix);
      const stat = this.files.lstat(path);
      if (stat === null) continue;
      if (!this.files.remove(path)) return 'io';
      if (account) {
        this.stats.bytes -= stat.size;
        if (this.stats.segments > 0) this.stats.segments--;
      }
    }
    return 'ok';
  }

  private cleanupOnePendingDelete(): StoreStatus {
    if (this.deleteFirst === 0) return 'ok';
    if (this.unlinkSegmentId(this.deleteFirst, false) !== 'ok') return 'io';
    const old = { first: this.deleteFirst, last: this.deleteLast, bytes: this.deleteBytes, segments: this.deleteSegments, statBytes: this.stats.bytes, statSegments: this.stats.segments };
    if (this.deleteFirst === this.deleteLast) {
      this.deleteFirst = 0;
      this.deleteLast = 0;
      this.deleteBytes = 0;
      this.deleteSegments = 0;
      this.stats.bytes = old.bytes > this.stats.bytes ? 0 : this.stats.bytes - old.bytes;
      this.stats.segments = old.segments > this.stats.segments ? 0 : this.stats.segments - old.segments;
    } else this.deleteFirst++;
    const status = this.writeState(true, true);
    if (status !== 'ok') {
      this.deleteFirst = old.first;
      this.deleteLast = old.last;
      this.deleteBytes = old.bytes;
      this.deleteSegments = old.segments;
      this.stats.bytes = old.statBytes;
      this.stats.segments = old.statSegments;
    }
    return status;
  }

  private deleteCommitted(): StoreStatus {
    const target = this.committedSegment;
    if (target !== 0 && this.firstLiveSegment < target) {
      const old = {
        first: this.firstLiveSegment, recoveryFirst: this.recoveryFirst, recoveryLast: this.recoveryLast,
        deleteFirst: this.deleteFirst, deleteLast: this.deleteLast, deleteBytes: this.deleteBytes, deleteSegments: this.deleteSegments,
      };
      let bytes = 0;
      let segments = 0;
      for (let id = old.first; id < target; id++) {
        for (const suffix of SUFFIXES) {
          const stat = this.files.lstat(this.path(id, suffix));
          if (stat !== null) {
            bytes += stat.size;
            segments++;
          }
        }
      }
      if (this.deleteFirst === 0) this.deleteFirst = old.first;
      this.deleteLast = target - 1;
      this.deleteBytes += bytes;
      this.deleteSegments += segments;
      this.firstLiveSegment = target;
      if (this.recoveryFirst !== 0 && target > this.recoveryFirst) {
        if (target > this.recoveryLast) {
          this.recoveryFirst = 0;
          this.recoveryLast = 0;
        } else this.recoveryFirst = target;
      }
      const status = this.writeState(true, true);
      if (status !== 'ok') {
        this.firstLiveSegment = old.first;
        this.recoveryFirst = old.recoveryFirst;
        this.recoveryLast = old.recoveryLast;
        this.deleteFirst = old.deleteFirst;
        this.deleteLast = old.deleteLast;
        this.deleteBytes = old.deleteBytes;
        this.deleteSegments = old.deleteSegments;
        return status;
      }
    }
    while (this.deleteFirst !== 0 && this.cleanupOnePendingDelete() === 'ok');
    if (this.deleteFirst !== 0) {
      this.error(RS_RET.IO_ERROR, 'segmentedDisk could not remove all committed segment files; the durable pending-delete range will be retried');
    }
    this.updateRetryOverage();
    return 'ok';
  }

  commit(position: QueuePosition): number {
    const index = position.index ?? this.committedIndex;
    const advanced = index - this.committedIndex;
    if (advanced <= 0) return 0;
    const before = this.stats.bytes;
    const old = {
      segment: this.committedSegment, offset: this.committedOffset, sequence: this.committedRecordSequence, size: this.knownQueueSize,
      updates: this.updatesSinceCheckpoint, index: this.committedIndex,
    };
    this.committedSegment = position.file;
    this.committedOffset = position.offset;
    this.committedRecordSequence = position.sequence ?? 0;
    this.knownQueueSize = advanced > this.knownQueueSize ? 0 : this.knownQueueSize - advanced;
    this.updatesSinceCheckpoint += advanced;
    this.committedIndex = index;
    let status: StoreStatus = 'ok';
    if (this.config.checkpointInterval !== 0 && this.updatesSinceCheckpoint >= this.config.checkpointInterval) {
      this.captureWriter();
      status = this.writeState(false, false);
    }
    if (status === 'ok') status = this.deleteCommitted();
    if (status !== 'ok') {
      this.committedSegment = old.segment;
      this.committedOffset = old.offset;
      this.committedRecordSequence = old.sequence;
      this.knownQueueSize = old.size;
      this.updatesSinceCheckpoint = old.updates;
      this.committedIndex = old.index;
      return 0;
    }
    return Math.max(0, before - this.stats.bytes);
  }

  persist(checkpoint: boolean): boolean {
    if (!this.materialized) return true;
    this.captureWriter();
    return this.writeState(!checkpoint, !checkpoint) === 'ok';
  }

  get mayHaveData(): boolean {
    if (this.deleteFirst !== 0) return true;
    if (this.readSegment !== null && this.readOffset < this.readSegment.dataEnd) return true;
    if (this.readSegment === null && this.readSegmentId !== 0 && this.readSegmentId <= this.lastDataSegment) return true;
    return this.active !== null && this.active.recordCount !== 0 && (this.readSegmentId < this.active.id || this.readOffset < this.active.dataEnd);
  }

  get canDematerialize(): boolean {
    return this.materialized && this.knownQueueSize === 0 && this.deleteFirst === 0 && (this.dematerializing || !this.mayHaveData);
  }

  dematerialize(): StoreStatus {
    if (!this.materialized) return 'ok';
    if (!this.canDematerialize) return 'retry';
    const restoreNext = this.nextSegment;
    this.dematerializing = true;
    const published = this.writeState(true, true);
    if (published !== 'ok') {
      this.dematerializing = false;
      this.stats.idleCleanupFailures++;
      return published;
    }
    this.activeHandle?.close();
    this.activeHandle = null;
    let status = this.removeRemainingSegments();
    if (status === 'ok' && !this.files.remove(this.statePath()) && this.files.exists(this.statePath())) status = 'io';
    this.active = null;
    this.readSegment = null;
    if (status === 'ok' && !this.files.rmdir(this.directory) && this.files.exists(this.directory)) status = 'io';
    if (status === 'ok') {
      this.materialized = false;
      this.resetAfterDematerialize();
      this.stats.dematerializations++;
    } else {
      this.stats.idleCleanupFailures++;
      const restored = this.restoreEmptyMaterialized(restoreNext);
      if (restored !== 'ok') this.error(RS_RET.IO_ERROR, 'failed to restore an empty segmentedDisk store after idle cleanup error');
    }
    return status;
  }

  private restoreEmptyMaterialized(nextSegment: number): StoreStatus {
    const oldUuid = this.uuid;
    const oldGeneration = this.generation;
    this.removeRemainingSegments();
    if (this.directoryHasSegments()) return 'io';
    const statePresent = this.files.exists(this.statePath());
    if (!statePresent && !this.files.write(this.statePath(), '\0'.repeat(STATE_FILE_LENGTH))) return 'io';
    this.resetAfterDematerialize();
    this.materialized = true;
    this.nextSegment = nextSegment === 0 ? 1 : nextSegment;
    if (statePresent) {
      this.uuid = oldUuid;
      this.generation = oldGeneration;
    } else this.uuid = this.randomUuid();
    this.dematerializing = true;
    if (!statePresent && this.writeState(true, true) !== 'ok') {
      this.files.remove(this.statePath());
      return 'io';
    }
    let status = this.createActive();
    if (status === 'ok') {
      this.dematerializing = false;
      status = this.writeState(true, true);
      if (status !== 'ok') this.dematerializing = true;
    }
    return status;
  }

  drop(): void {
    this.activeHandle?.close();
    this.activeHandle = null;
    if (!this.materialized) return;
    this.removeRemainingSegments();
    this.files.remove(this.statePath());
    this.files.rmdir(this.directory);
    this.materialized = false;
    this.resetAfterDematerialize();
  }

  close(queueSize: number): void {
    if (!this.materialized) return;
    const empty = queueSize === 0;
    let status: StoreStatus = 'ok';
    if (this.activeHandle !== null) {
      if (!empty && this.active !== null && this.active.recordCount !== 0) status = this.sealActive();
      else {
        this.activeHandle.close();
        this.activeHandle = null;
      }
    }
    if (empty) {
      const end = Math.max(this.activeSegment, this.lastDataSegment);
      for (let id = this.firstLiveSegment; id !== 0 && id <= end; id++) {
        const local = this.unlinkSegmentId(id, false);
        if (local !== 'ok' && status === 'ok') status = local;
      }
      if (status === 'ok') status = this.removeRemainingSegments();
      if (status === 'ok' && !this.files.remove(this.statePath()) && this.files.exists(this.statePath())) status = 'io';
    } else if (status === 'ok') {
      this.captureWriter();
      status = this.writeState(true, true);
    }
    this.active = null;
    this.readSegment = null;
    if (empty && status === 'ok' && !this.files.rmdir(this.directory) && this.files.exists(this.directory)) status = 'io';
    this.materialized = false;
    if (status !== 'ok') this.error(RS_RET.IO_ERROR, 'segmentedDisk could not be closed cleanly');
  }
}
