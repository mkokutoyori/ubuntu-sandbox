import type { CryptoFile, CryptoProvider } from '../crypto/CryptoProvider';
import type { FileHandle, RsyslogFiles } from './Host';
import { latin1Bytes, latin1Text } from './Latin1';
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

const CRYPTO_READ_BUFFER = 4096;
const RS_RET_ERR = -3000;

interface PlainFile {
  readonly content: string;
  readonly padded: boolean;
  physicalOffset(index: number): number;
  charAt(offset: number): number;
}

export interface DiskQueueSettings {
  readonly directory: string;
  readonly prefix: string;
  readonly maxFileSize: number;
  readonly maxDiskSpace: number;
}

export interface LoadOptions {
  readonly resynchronize: boolean;
  readonly report?: (severity: number, code: number, text: string) => void;
}

const RESYNC_MAX_SCAN = 1024 * 1024;
const LOG_ALERT = 1;
const LOG_WARNING = 4;

export interface DiskQueueEnvironment {
  readonly name?: string;
  readonly files: RsyslogFiles;
  readonly codec: () => MessageCodecContext;
  readonly report: (severity: number, text: string) => void;
  readonly crypto?: CryptoProvider | null;
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
  private encrypted: CryptoFile | null = null;
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
    const written = this.writeText(text);
    if (typeof written === 'string') return written;
    this.sizeOnDisk += written;
    this.positions.set(message, { file: oldFile, offset: this.writeOffset });
    if (this.writeOffset >= this.settings.maxFileSize) this.closeWriteFile();
    if (this.writeFile !== oldFile) this.forcePersist = 2;
    return null;
  }

  private writeText(text: string): string | number {
    const path = queueFileName(this.settings.directory, this.settings.prefix, this.writeFile);
    if (this.handle === null) {
      const opened = this.environment.files.open(path, this.openOptions);
      if ('error' in opened) return opened.error;
      this.handle = opened.handle;
      const crypto = this.environment.crypto ?? null;
      if (crypto !== null) {
        const file = crypto.openFile(path, 'w');
        if ('error' in file) {
          this.handle.close();
          this.handle = null;
          return file.error;
        }
        this.encrypted = file;
      }
    }
    const payload = this.encrypted === null ? text : latin1Text(this.encrypted.encrypt(new TextEncoder().encode(text)));
    const failure = this.handle.write(payload);
    if (failure !== null) return failure;
    this.handle.flush();
    this.writeOffset += payload.length;
    return payload.length;
  }

  private closeWriteFile(): void {
    this.handle?.close();
    this.handle = null;
    this.encrypted?.close(this.writeOffset);
    this.encrypted = null;
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
      this.removeQueueFile(path);
    }
    this.deleteFile = Math.max(this.deleteFile, position.file);
    this.deleteOffset = position.offset;
    this.sizeOnDisk = Math.max(0, this.sizeOnDisk - deleted);
    return deleted;
  }

  private removeQueueFile(path: string): void {
    this.environment.files.remove(path);
    this.environment.crypto?.deleteStateFiles(path);
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

  abandon(): void {
    this.handle?.close();
    this.handle = null;
    this.encrypted?.close(this.writeOffset);
    this.encrypted = null;
  }

  resetState(): void {
    this.writeFile = 1;
    this.writeOffset = 0;
    this.deleteFile = 1;
    this.deleteOffset = 0;
    this.sizeOnDisk = 0;
    this.forcePersist = 0;
    this.needDeleteInfoFile = false;
    this.deleteOnClose = true;
  }

  drop(): void {
    const files = this.environment.files;
    this.handle?.close();
    this.handle = null;
    this.encrypted?.close(this.writeOffset);
    this.encrypted = null;
    for (let file = this.deleteFile; file <= this.writeFile; file++) {
      this.removeQueueFile(queueFileName(this.settings.directory, this.settings.prefix, file));
    }
    files.remove(this.infoFile);
    this.sizeOnDisk = 0;
    this.needDeleteInfoFile = false;
  }

  close(queueSize: number): void {
    this.handle?.close();
    this.handle = null;
    this.encrypted?.close(this.writeOffset);
    this.encrypted = null;
    if (queueSize === 0) {
      this.removeQueueFile(queueFileName(this.settings.directory, this.settings.prefix, this.writeFile));
    }
    if (this.deleteOnClose) {
      this.removeQueueFile(queueFileName(this.settings.directory, this.settings.prefix, this.deleteFile));
    }
  }

  private readPlain(path: string): PlainFile | null {
    const text = this.environment.files.read(path);
    if (text === null) return null;
    const crypto = this.environment.crypto ?? null;
    if (crypto === null) return { content: text, padded: false, physicalOffset: (index) => index, charAt: (offset) => offset };
    const bytes = latin1Bytes(text);
    const file = crypto.openFile(path, 'r');
    if ('error' in file) throw new ObjectStreamError(file.error);
    const pieces: Uint8Array[] = [];
    let physical = 0;
    while (physical < bytes.length) {
      const left = file.bytesLeftInBlock();
      if (typeof left === 'object') throw new ObjectStreamError('cannot read the encryption info file');
      let toRead = left === -1 || left > CRYPTO_READ_BUFFER ? CRYPTO_READ_BUFFER : left;
      toRead = Math.min(toRead, bytes.length - physical);
      if (toRead <= 0) break;
      pieces.push(file.decryptPadded(bytes.subarray(physical, physical + toRead)));
      physical += toRead;
    }
    file.close(0);
    const plain = new Uint8Array(physical);
    let at = 0;
    for (const piece of pieces) {
      plain.set(piece, at);
      at += piece.length;
    }
    const content = new TextDecoder('utf-8').decode(plain);
    const bytesBefore = new Uint32Array(content.length + 1);
    for (let index = 0; index < content.length; index++) {
      const code = content.charCodeAt(index);
      const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff ? 4 : code >= 0xdc00 && code <= 0xdfff ? 0 : 3;
      bytesBefore[index + 1] = bytesBefore[index] + width;
    }
    return {
      content,
      padded: true,
      physicalOffset: (index) => bytesBefore[Math.min(index, content.length)],
      charAt: (offset) => {
        let low = 0;
        let high = content.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if (bytesBefore[middle] < offset) low = middle + 1;
          else high = middle;
        }
        return low;
      },
    };
  }

  load(options: LoadOptions = { resynchronize: false }): LoadedBacklog | null {
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
    let unrecoverable = false;
    for (let file = this.deleteFile; file <= this.writeFile; file++) {
      const path = queueFileName(this.settings.directory, this.settings.prefix, file);
      const plain = this.readPlain(path);
      if (plain === null) continue;
      const { content, physicalOffset } = plain;
      const limitChar = file === this.writeFile ? plain.charAt(this.writeOffset) : content.length;
      let at = file === this.deleteFile ? plain.charAt(this.deleteOffset) : 0;
      while (at < limitChar) {
        if (plain.padded && content.charCodeAt(at) === 0) {
          at++;
          continue;
        }
        let decoded: { message: RsyslogMessage; end: number };
        try {
          decoded = this.decodeAt(content, at);
        } catch (error) {
          if (!(error instanceof ObjectStreamError) || !options.resynchronize) throw error;
          const recovered = this.resynchronize(content, at, limitChar, file, plain, options);
          if (recovered === null) {
            unrecoverable = true;
            break;
          }
          decoded = recovered;
        }
        at = decoded.end;
        while (at < content.length && content.charCodeAt(at) === 0 && plain.padded) at++;
        const position = { file, offset: plain.physicalOffset(at) };
        this.positions.set(decoded.message, position);
        messages.push(decoded.message);
        positions.push(position);
      }
      if (unrecoverable) break;
    }
    return unrecoverable ? { messages, positions, unrecoverable } : { messages, positions };
  }

  private decodeAt(content: string, at: number): { message: RsyslogMessage; end: number } {
    const record = readRecord(content, at);
    return { message: deserializeMessage(record, this.environment.codec()), end: record.end };
  }

  private resynchronize(
    content: string, start: number, limit: number, file: number, plain: PlainFile, options: LoadOptions,
  ): { message: RsyslogMessage; end: number } | null {
    const name = this.environment.name ?? this.settings.prefix;
    const report = options.report ?? (() => undefined);
    report(LOG_ALERT, RS_RET_ERR, `${name}: disk queue corruption detected while dequeuing at file ${file} offset ${plain.physicalOffset(start)}; attempting bounded resync`);
    let scanned = 0;
    for (let index = start; index < limit && scanned < RESYNC_MAX_SCAN;) {
      const character = content[index++];
      scanned++;
      if (character !== '<') continue;
      try {
        const recovered = this.decodeAt(content, index - 1);
        report(LOG_WARNING, 0, `${name}: disk queue corruption recovery resumed after skipping a damaged record; resynchronized at file ${file} offset ${plain.physicalOffset(recovered.end)} after scanning ${scanned} bytes`);
        return recovered;
      } catch (error) {
        if (!(error instanceof ObjectStreamError)) throw error;
      }
    }
    report(LOG_ALERT, RS_RET_ERR, `${name}: disk queue corruption recovery failed after bounded scan of ${scanned} bytes; quarantining unread tail`);
    return null;
  }
}
