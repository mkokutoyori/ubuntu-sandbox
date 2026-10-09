import { type JournalFile, JournalFileSet, type FileIdentity } from './JournalFileSet';
import { DEFAULT_JOURNALD_SETTINGS, JournaldServer, type JournaldHost, type JournaldSettings, type ProcessFacts, type Ucred, type StdoutStream } from './JournaldServer';
import { type JournalFileInfo, type VacuumResult, type VacuumSpec } from './JournalctlTool';
import { type JournalRecord } from './JournalRecord';
import { formatBytes, utf8 } from './JournalText';

export interface JournaldPlatform {
  nowUsec(): number;
  bootUsec(): number;
  machineId(): string;
  hostname(): string;
  probe(pid: number): ProcessFacts | null;
  journaldPid(): number | null;
  persistentStorage(): boolean;
  diskFreeBytes(): number;
}

export interface KernelMessage {
  priority: number;
  message: string;
  monotonicUsec: number;
  realtimeUsec?: number;
}

const JOURNAL_STARTED = 'f77379a8490b408bbe5f6940505a777b';
const SPACE_USAGE = 'ec387f577b844b8fa948f33cad9a75e6';
const MAX_USE = 4 * 1024 ** 3;
const KEEP_FREE = 4 * 1024 ** 3;

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
  private readonly files: JournalFileSet;
  private readonly server: JournaldServer;
  private readonly listeners = new Set<(record: JournalRecord) => void>();
  private stamp: { realtimeUsec: number } | null = null;
  private streamCounter = 0;
  private flushed = false;

  constructor(private readonly platform: JournaldPlatform, settings: JournaldSettings = DEFAULT_JOURNALD_SETTINGS) {
    this.bootId = hex128(`boot:${platform.hostname()}:${platform.machineId()}:${platform.bootUsec()}`);
    this.files = new JournalFileSet(index => this.identityOf(index), 1);
    const host: JournaldHost = {
      probe: pid => platform.probe(pid),
      identity: () => ({ bootId: this.bootId, machineId: platform.machineId(), hostname: platform.hostname() }),
      cgroupRoot: () => '/',
      newStreamId: () => hex128(`stream:${this.bootId}:${this.streamCounter++}`),
      write: items => this.store(items),
    };
    this.server = new JournaldServer(host, settings);
    this.server.selfContext = null;
  }

  private identityOf(index: number): FileIdentity {
    const machineId = this.platform.machineId();
    return { path: `${this.directory}/system.journal`, fileId: hex128(`file:${this.bootId}:${index}`), seqnumId: hex128(`seqnum:${this.bootId}`), machineId };
  }

  private store(items: Uint8Array[]): void {
    const realtime = this.stamp !== null ? this.stamp.realtimeUsec : this.platform.nowUsec();
    const monotonic = Math.max(0, realtime - this.platform.bootUsec());
    const record = this.files.append(items, realtime, monotonic, this.bootId);
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

  start(): void {
    this.selfContextRefresh();
    this.server.driverMessage(JOURNAL_STARTED, 'Journal started');
    this.spaceUsageMessage();
  }

  private selfContextRefresh(): void {
    const pid = this.platform.journaldPid();
    this.server.selfContext = pid === null ? null : this.server.acquireContext({ pid, uid: 0, gid: 0 }, null, null);
  }

  private spaceUsageMessage(): void {
    const persistent = this.platform.persistentStorage();
    const machineId = this.platform.machineId();
    const name = persistent ? 'System Journal' : 'Runtime Journal';
    const path = persistent ? `/var/log/journal/${machineId}` : `/run/log/journal/${machineId}`;
    const current = this.files.all.reduce((sum, file) => sum + (file.records.length > 0 ? 8 * 1024 * 1024 : 0), 0) || 8 * 1024 * 1024;
    const free = this.platform.diskFreeBytes();
    const available = Math.max(0, Math.min(MAX_USE, free - KEEP_FREE) - current);
    const limit = MAX_USE;
    const pretty = (n: number): string => formatBytes(n);
    this.server.driverMessage(SPACE_USAGE, `${name} (${path}) is ${pretty(current)}, max ${pretty(limit)}, ${pretty(available)} free.`, [
      ['JOURNAL_NAME', name], ['JOURNAL_PATH', path], ['CURRENT_USE', String(current)], ['CURRENT_USE_PRETTY', pretty(current)], ['MAX_USE', String(MAX_USE)],
      ['MAX_USE_PRETTY', pretty(MAX_USE)], ['DISK_KEEP_FREE', String(KEEP_FREE)], ['DISK_KEEP_FREE_PRETTY', pretty(KEEP_FREE)], ['DISK_AVAILABLE', String(free)],
      ['DISK_AVAILABLE_PRETTY', pretty(free)], ['LIMIT', String(limit)], ['LIMIT_PRETTY', pretty(limit)], ['AVAILABLE', String(available)], ['AVAILABLE_PRETTY', pretty(available)],
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
    const priority = message.priority & 0x3ff;
    const items = [utf8(`_SOURCE_MONOTONIC_TIMESTAMP=${message.monotonicUsec}`), utf8('_TRANSPORT=kernel'), utf8(`PRIORITY=${priority & 7}`), utf8(`SYSLOG_FACILITY=${priority >> 3}`), utf8('SYSLOG_IDENTIFIER=kernel'), utf8(`MESSAGE=${message.message}`)];
    const run = (): void => this.server.dispatch(items, null, null, priority, 0);
    if (message.realtimeUsec !== undefined) this.withStamp(message.realtimeUsec, run);
    else run();
  }

  onRecord(listener: (record: JournalRecord) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  records(): readonly JournalRecord[] {
    return this.files.records();
  }

  fileInfos(): JournalFileInfo[] {
    return this.files.all.map(file => file.info());
  }

  rotate(): void {
    this.files.rotate();
  }

  vacuum(spec: VacuumSpec): VacuumResult[] {
    const directory = this.directory;
    const archived = this.files.all.filter(file => file.state === 'ARCHIVED');
    const now = this.platform.nowUsec();
    const sizeOf = 8 * 1024 * 1024;
    const doomed = new Set<JournalFile>();
    if (spec.time > 0) for (const file of archived) if ((file.records[file.records.length - 1]?.realtimeUsec ?? 0) < now - spec.time) doomed.add(file);
    const newestFirst = [...archived].reverse().filter(file => !doomed.has(file));
    if (spec.files > 0) newestFirst.slice(spec.files).forEach(file => doomed.add(file));
    if (spec.size > 0) {
      let used = sizeOf;
      for (const file of newestFirst) {
        if (doomed.has(file)) continue;
        used += sizeOf;
        if (used > spec.size) doomed.add(file);
      }
    }
    const deleted = archived.filter(file => doomed.has(file)).map(file => ({ name: file.path.slice(file.path.lastIndexOf('/') + 1), bytes: sizeOf }));
    this.files.remove(file => doomed.has(file));
    return [{ directory, deleted, freedBytes: deleted.length * sizeOf }];
  }

  markFlushed(): void {
    this.flushed = true;
  }

  isFlushed(): boolean {
    return this.flushed;
  }

  usageBytes(): number {
    return this.files.all.length * 8 * 1024 * 1024;
  }

  get directory(): string {
    const machineId = this.platform.machineId();
    return this.platform.persistentStorage() ? `/var/log/journal/${machineId}` : `/run/log/journal/${machineId}`;
  }

  get settings(): JournaldSettings {
    return this.server.settings;
  }
}
