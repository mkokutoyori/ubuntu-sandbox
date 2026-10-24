import type { FileHandle, RsyslogFiles } from './Host';
import { ObjectStreamError, ObjectWriter, readRecord, readRecords, type ObjectRecord, type PropertyValue } from './ObjectStream';
import { deserializeMessage, serializeMessage, type MessageCodecContext } from './MessageCodec';
import type { RsyslogMessage } from '../Message';
import type { LoadedBacklog, QueuePosition, QueueStore } from './QueueStore';

export const MAX_DISK_QUEUE_FILES = 10_000_000;
const FILE_NUMBER_DIGITS = 8;
const QUEUE_OBJECT_ID = 'qqueue';
const STREAM_OBJECT_ID = 'strm';
const STREAM_TYPE_FILE_CIRCULAR = 1;
const STREAM_MODE_READ = 1;
const STREAM_MODE_WRITE = 2;
const OPEN_MODE = 0o600;

export interface DiskQueueSettings {
  readonly directory: string;
  readonly prefix: string;
  readonly maxFileSize: number;
  readonly maxDiskSpace: number;
}

export interface DiskQueueEnvironment {
  readonly files: RsyslogFiles;
  readonly codec: () => MessageCodecContext;
  readonly report: (severity: number, text: string) => void;
}

export function queueFileName(directory: string, prefix: string, number: number): string {
  return `${directory}/${prefix}.${String(number).padStart(FILE_NUMBER_DIGITS, '0')}`;
}

function numberOf(properties: Map<string, PropertyValue>, name: string): number {
  const value = properties.get(name);
  if (value?.kind !== 'number') throw new ObjectStreamError(`property ${name} is missing`);
  return value.value;
}

function propertiesOf(record: ObjectRecord): Map<string, PropertyValue> {
  return new Map(record.properties.map((property) => [property.name, property.value]));
}

export class DiskQueueStore implements QueueStore {
  readonly managesCheckpoints = false;
  sizeOnDisk = 0;
  private writeFile = 1;
  private writeOffset = 0;
  private deleteFile = 1;
  private deleteOffset = 0;
  private handle: FileHandle | null = null;
  private forcePersist = 0;
  private needDeleteInfoFile = false;
  private deleteOnClose = true;
  private readonly positions = new WeakMap<object, QueuePosition>();

  constructor(
    readonly settings: DiskQueueSettings,
    private readonly environment: DiskQueueEnvironment,
    private readonly openOptions: import('./Host').OpenFileOptions,
  ) {}

  get infoFile(): string {
    return `${this.settings.directory}/${this.settings.prefix}.qi`;
  }

  get currentWriteFile(): number {
    return this.writeFile;
  }

  get currentDeleteFile(): number {
    return this.deleteFile;
  }

  positionOf(item: object): QueuePosition | undefined {
    return this.positions.get(item);
  }

  markDequeued(): void {}

  exceedsDiskSpace(): boolean {
    return this.settings.maxDiskSpace !== 0 && this.sizeOnDisk > this.settings.maxDiskSpace;
  }

  append(message: RsyslogMessage): string | null {
    const text = serializeMessage(message, this.environment.codec());
    const oldFile = this.writeFile;
    const failure = this.writeText(text);
    if (failure !== null) return failure;
    this.sizeOnDisk += text.length;
    this.positions.set(message, { file: oldFile, offset: this.writeOffset });
    if (this.writeOffset >= this.settings.maxFileSize) this.closeWriteFile();
    if (this.writeFile !== oldFile) this.forcePersist = 2;
    return null;
  }

  private writeText(text: string): string | null {
    if (this.handle === null) {
      const opened = this.environment.files.open(queueFileName(this.settings.directory, this.settings.prefix, this.writeFile), this.openOptions);
      if ('error' in opened) return opened.error;
      this.handle = opened.handle;
    }
    const failure = this.handle.write(text);
    if (failure !== null) return failure;
    this.handle.flush();
    this.writeOffset += text.length;
    return null;
  }

  private closeWriteFile(): void {
    this.handle?.close();
    this.handle = null;
    this.writeFile = (this.writeFile + 1) % MAX_DISK_QUEUE_FILES;
    this.writeOffset = 0;
  }

  takePendingPersist(): boolean {
    if (this.forcePersist === 0) return false;
    this.forcePersist--;
    return true;
  }

  commit(position: QueuePosition): number {
    let deleted = 0;
    for (let file = this.deleteFile; file < position.file; file++) {
      const path = queueFileName(this.settings.directory, this.settings.prefix, file);
      deleted += this.environment.files.statSize(path) ?? 0;
      this.environment.files.remove(path);
    }
    this.deleteFile = Math.max(this.deleteFile, position.file);
    this.deleteOffset = position.offset;
    this.sizeOnDisk = Math.max(0, this.sizeOnDisk - deleted);
    return deleted;
  }

  persist(checkpoint: boolean, queueSize: number): boolean {
    const files = this.environment.files;
    if (!checkpoint && queueSize === 0) {
      if (this.needDeleteInfoFile) {
        files.remove(this.infoFile);
        this.needDeleteInfoFile = false;
      }
      this.deleteOnClose = true;
      return true;
    }
    files.remove(this.infoFile);
    const opened = files.open(this.infoFile, this.openOptions);
    if ('error' in opened) return false;
    const text = [
      new ObjectWriter(QUEUE_OBJECT_ID, 1, 'OPB').number('iQueueSize', queueSize).number('tVars.disk.sizeOnDisk', this.sizeOnDisk).finish(),
      this.streamRecord(this.writeFile, STREAM_MODE_WRITE, this.writeOffset, this.handle !== null ? this.inodeOf(this.writeFile) : 0, false),
      this.streamRecord(this.deleteFile, STREAM_MODE_READ, this.deleteOffset, 0, this.deleteOnClose),
    ].join('');
    const failure = opened.handle.write(text);
    opened.handle.flush();
    opened.handle.close();
    if (failure !== null) return false;
    if (!checkpoint) this.deleteOnClose = false;
    this.needDeleteInfoFile = true;
    return true;
  }

  private inodeOf(file: number): number {
    return this.environment.files.stat(queueFileName(this.settings.directory, this.settings.prefix, file))?.inode ?? 0;
  }

  private streamRecord(file: number, mode: number, offset: number, inode: number, deleteOnClose: boolean): string {
    return new ObjectWriter(STREAM_OBJECT_ID, 1)
      .number('iCurrFNum', file)
      .string('pszFName', this.settings.prefix)
      .number('iMaxFiles', MAX_DISK_QUEUE_FILES)
      .number('bDeleteOnClose', deleteOnClose ? 1 : 0)
      .number('sType', STREAM_TYPE_FILE_CIRCULAR)
      .number('tOperationsMode', mode)
      .number('tOpenMode', OPEN_MODE)
      .number('iCurrOffs', offset)
      .number('inode', inode)
      .number('strtOffs', mode === STREAM_MODE_READ ? offset : 0)
      .number('bPrevWasNL', 0)
      .finish();
  }

  drop(): void {
    const files = this.environment.files;
    this.handle?.close();
    this.handle = null;
    for (let file = this.deleteFile; file <= this.writeFile; file++) {
      files.remove(queueFileName(this.settings.directory, this.settings.prefix, file));
    }
    files.remove(this.infoFile);
    this.sizeOnDisk = 0;
    this.needDeleteInfoFile = false;
  }

  close(queueSize: number): void {
    this.handle?.close();
    this.handle = null;
    if (queueSize === 0) {
      this.environment.files.remove(queueFileName(this.settings.directory, this.settings.prefix, this.writeFile));
    }
    if (this.deleteOnClose) {
      this.environment.files.remove(queueFileName(this.settings.directory, this.settings.prefix, this.deleteFile));
    }
  }

  load(): LoadedBacklog | null {
    const files = this.environment.files;
    const text = files.read(this.infoFile);
    if (text === null) return null;
    const records = readRecords(text);
    const bag = records[0];
    const write = records[1];
    const del = records[2];
    if (bag === undefined || write === undefined || del === undefined) throw new ObjectStreamError('incomplete queue info file');
    const sizeOnDisk = numberOf(propertiesOf(bag), 'tVars.disk.sizeOnDisk');
    const writeProperties = propertiesOf(write);
    const deleteProperties = propertiesOf(del);
    this.sizeOnDisk = sizeOnDisk;
    this.writeFile = numberOf(writeProperties, 'iCurrFNum');
    this.writeOffset = numberOf(writeProperties, 'iCurrOffs');
    this.deleteFile = numberOf(deleteProperties, 'iCurrFNum');
    this.deleteOffset = numberOf(deleteProperties, 'iCurrOffs');
    this.needDeleteInfoFile = true;
    const messages: RsyslogMessage[] = [];
    const positions: QueuePosition[] = [];
    for (let file = this.deleteFile; file <= this.writeFile; file++) {
      const content = files.read(queueFileName(this.settings.directory, this.settings.prefix, file));
      if (content === null) continue;
      const limit = file === this.writeFile ? this.writeOffset : content.length;
      let at = file === this.deleteFile ? this.deleteOffset : 0;
      while (at < limit) {
        const record = readRecord(content, at);
        const message = deserializeMessage(record, this.environment.codec());
        at = record.end;
        const position = { file, offset: at };
        this.positions.set(message, position);
        messages.push(message);
        positions.push(position);
      }
    }
    return { messages, positions };
  }
}
