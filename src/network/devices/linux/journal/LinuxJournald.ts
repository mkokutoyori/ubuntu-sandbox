import { buildRecord, distinctPayloads } from './JournalFileSet';
import { JournalStorage, type SpaceInfo } from './JournalStorage';
import { defaultJournaldSettings, JournaldServer, type JournaldHost, type JournaldSettings, type ProcessFacts, type Ucred, type StdoutStream, type WriteTarget } from './JournaldServer';
import { type JournalFileInfo, type VacuumResult, type VacuumSpec, type VerifyOutcome } from './JournalctlTool';
import { parseVerificationKey } from './seal/SealingKeyFile';
import { verifySeal } from './seal/SealVerifier';
import { type JournalRecord } from './JournalRecord';
import { concat, formatBytes, utf8 } from './JournalText';
import type { SealKey } from './seal/SealChain';

export interface JournaldPlatform {
  nowUsec(): number;
  bootUsec(): number;
  machineId(): string;
  hostname(): string;
  probe(pid: number): ProcessFacts | null;
  journaldPid(): number | null;
  persistentStorage(): boolean;
  filesystem(): { sizeBytes: number; availableBytes: number };
  trustedClock(): boolean;
  filesChanged?(): void;
  sealingKey?(): SealKey | null;
  schedule?(delayMs: number, callback: () => void): () => void;
}

export interface KernelMessage {
  priority: number;
  message: string;
  monotonicUsec: number;
  realtimeUsec?: number;
  serial?: number;
}

const JOURNAL_STARTED = 'f77379a8490b408bbe5f6940505a777b';
const JOURNAL_STOPPED = 'd93fb3c9c24d451a97cea615ce59c00b';
const SPACE_USAGE = 'ec387f577b844b8fa948f33cad9a75e6';

function hex128(seed: string): string {
  let a = 0xcbf29ce484222325n;
  let b = 0x84222325cbf29ce4n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < seed.length; i++) {
    const c = BigInt(seed.charCodeAt(i));
    a = ((a ^ c) * 0x100000001b3n) & mask;
    b = ((b ^ (c + BigInt(i))) * 0x100000001b3n) & mask;
  }
  return a.toString(16).padStart(16, '0') + b.toString(16).padStart(16, '0');
}

export class LinuxJournald {
  readonly bootId: string;
  private readonly storage: JournalStorage;
  private readonly server: JournaldServer;
  private readonly listeners = new Set<(record: JournalRecord) => void>();
  private stamp: { realtimeUsec: number } | null = null;
  private streamCounter = 0;
  private flushed = false;
  private kmsgSequence = 0;
  private unstoredSequence = 1;

  constructor(private readonly platform: JournaldPlatform, settings: JournaldSettings = defaultJournaldSettings(), firstSeqnum = 1) {
    this.bootId = hex128(`boot:${platform.hostname()}:${platform.machineId()}:${platform.bootUsec()}`);
    const host: JournaldHost = {
      probe: pid => platform.probe(pid),
      identity: () => ({ bootId: this.bootId, machineId: platform.machineId(), hostname: platform.hostname() }),
      cgroupRoot: () => '/',
      newStreamId: () => hex128(`stream:${this.bootId}:${this.streamCounter++}`),
      write: (items, priority, target) => this.store(items, priority, target),
      monotonicUsec: () => Math.max(1, platform.nowUsec() - platform.bootUsec()),
      availableBytes: () => this.storage.availableBytes(),
    };
    this.server = new JournaldServer(host, structuredClone(settings));
    this.server.selfContext = null;
    this.storage = new JournalStorage({
      nowUsec: () => platform.nowUsec(),
      monotonicUsec: () => host.monotonicUsec(),
      directory: () => this.directory,
      persistent: () => platform.persistentStorage(),
      trustedClock: () => platform.trustedClock(),
      filesystem: () => platform.filesystem(),
      fileIds: (stem, serial) => ({ fileId: hex128(`file:${this.bootId}:${stem}:${serial}`), seqnumId: hex128(`seqnum:${this.bootId}`), machineId: platform.machineId() }),
      filesChanged: () => platform.filesChanged?.(),
      sealingKey: platform.sealingKey === undefined ? undefined : () => platform.sealingKey!(),
      schedule: platform.schedule === undefined ? undefined : (delayMs, callback) => platform.schedule!(delayMs, callback),
      announceSpace: (space) => this.spaceUsageMessage(space),
    }, () => this.server.settings, firstSeqnum);
  }

  verify(path: string, keyText: string | null, format: (usec: number) => string): VerifyOutcome {
    const file = this.storage.fileByPath(path);
    const sealed = file !== null && file.seal !== null;
    const key = keyText === null ? null : parseVerificationKey(keyText);
    if (keyText !== null && key === null) return { kind: 'invalid-key' };
    const first = file?.records[0]?.realtimeUsec ?? 0;
    const last = file?.records[file.records.length - 1]?.realtimeUsec ?? 0;
    if (file === null || !sealed) return { kind: 'pass', sealed: false, first, validated: 0, last };
    if (key === null) return { kind: 'fail', errno: 'ENOKEY', lines: [], corruption: null };
    const outcome = verifySeal(file, key, format);
    if (outcome.ok === false) {
      return { kind: 'fail', errno: 'EBADMSG', lines: [`${outcome.offset.toString(16).padStart(6, '0')}: ${outcome.message}`], corruption: { offset: outcome.offset, size: file.fileSize } };
    }
    return { kind: 'pass', sealed: true, first, validated: outcome.validatedUsec, last };
  }

  reconfigure(): void {
    this.storage.reconfigure();
  }

  private store(items: Uint8Array[], priority: number, target: WriteTarget): void {
    const realtime = this.stamp !== null ? this.stamp.realtimeUsec : this.platform.nowUsec();
    const monotonic = Math.max(0, realtime - this.platform.bootUsec());
    const stored = target.stored ? this.storage.write(items, priority, target.uid, realtime, monotonic, this.bootId) : null;
    const record = stored ?? buildRecord(distinctPayloads(items), realtime, monotonic, this.unstoredSequence++, this.storage.seqnumId, this.bootId);
    for (const listener of [...this.listeners]) listener(record);
  }

  withStamp<T>(realtimeUsec: number, action: () => T): T {
    this.stamp = { realtimeUsec };
    try {
      return action();
    } finally {
      this.stamp = null;
    }
  }

  bind(): void {
    this.selfContextRefresh();
    this.storage.vacuum(false);
    this.storage.patchMinUse();
  }

  start(): void {
    this.bind();
    this.server.driverMessage(JOURNAL_STARTED, 'Journal started');
    this.spaceUsageMessage(this.storage.spaceInfo());
  }

  copyEntry(fields: ReadonlyArray<readonly [string, Uint8Array]>, realtimeUsec: number, monotonicUsec: number, bootId: string): JournalRecord | null {
    const items = fields.map(([name, value]) => concat(utf8(`${name}=`), value));
    return this.storage.write(items, 6, 0, realtimeUsec, monotonicUsec, bootId);
  }

  stop(): void {
    this.server.driverMessage(JOURNAL_STOPPED, 'Journal stopped');
    this.storage.sync();
  }

  private selfContextRefresh(): void {
    const pid = this.platform.journaldPid();
    this.server.selfContext = pid === null ? null : this.server.acquireContext({ pid, uid: 0, gid: 0 }, null, null);
  }

  private spaceUsageMessage(space: SpaceInfo): void {
    const pretty = (n: number): string => formatBytes(n);
    this.server.driverMessage(SPACE_USAGE, `${space.name} (${space.path}) is ${pretty(space.vfsUsed)}, max ${pretty(space.limit)}, ${pretty(space.available)} free.`, [
      ['JOURNAL_NAME', space.name], ['JOURNAL_PATH', space.path], ['CURRENT_USE', String(space.vfsUsed)], ['CURRENT_USE_PRETTY', pretty(space.vfsUsed)],
      ['MAX_USE', String(space.metrics.maxUse)], ['MAX_USE_PRETTY', pretty(space.metrics.maxUse)], ['DISK_KEEP_FREE', String(space.metrics.keepFree)],
      ['DISK_KEEP_FREE_PRETTY', pretty(space.metrics.keepFree)], ['DISK_AVAILABLE', String(space.vfsAvailable)], ['DISK_AVAILABLE_PRETTY', pretty(space.vfsAvailable)],
      ['LIMIT', String(space.limit)], ['LIMIT_PRETTY', pretty(space.limit)], ['AVAILABLE', String(space.available)], ['AVAILABLE_PRETTY', pretty(space.available)],
    ]);
  }

  deliverSyslog(bytes: Uint8Array, ucred: Ucred | null, label: Uint8Array | null = null, tvUsec: number | null = null): void {
    this.server.processSyslog(bytes, ucred, tvUsec ?? this.platform.nowUsec(), label);
  }

  deliverNative(bytes: Uint8Array, ucred: Ucred | null, label: Uint8Array | null = null, tvUsec: number | null = null): void {
    this.server.processNative(bytes, ucred, tvUsec ?? this.platform.nowUsec(), label);
  }

  openStdoutStream(ucred: Ucred, label: Uint8Array | null = null): StdoutStream {
    return this.server.openStdoutStream(ucred, label);
  }

  deliverKernel(message: KernelMessage): void {
    const escaped = Array.from(new TextEncoder().encode(message.message), byte => (byte >= 0x20 && byte < 0x7f && byte !== 0x5c ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, '0')}`)).join('');
    const record = utf8(`${message.priority & 0x3ff},${message.serial ?? this.kmsgSequence++},${Math.floor(message.monotonicUsec)},-;${escaped}\n`);
    const run = (): void => this.server.processKmsg(record);
    if (message.realtimeUsec !== undefined) this.withStamp(message.realtimeUsec, run);
    else run();
  }

  onRecord(listener: (record: JournalRecord) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  records(): readonly JournalRecord[] {
    return this.storage.records();
  }

  fileInfos(): JournalFileInfo[] {
    return this.storage.fileInfos();
  }

  rotate(): void {
    this.storage.fullRotate();
  }

  vacuum(spec: VacuumSpec): VacuumResult[] {
    return this.storage.vacuumDirectory(spec);
  }

  markFlushed(): void {
    this.flushed = true;
  }

  isFlushed(): boolean {
    return this.flushed;
  }

  usageBytes(): number {
    return this.storage.usageBytes();
  }

  get directory(): string {
    const machineId = this.platform.machineId();
    return this.platform.persistentStorage() ? `/var/log/journal/${machineId}` : `/run/log/journal/${machineId}`;
  }

  get settings(): JournaldSettings {
    return this.server.settings;
  }
}
