import type { FileHandle } from '../engine/Host';
import { RS_RET } from '../engine/Log';
import { GzipStreamWriter } from '../Zlib';
import type { CryptoFile, CryptoProvider } from '../crypto/CryptoProvider';
import { bytesToFileText } from '@/crypto/encoding';
import { ZstdStreamWriter } from '../Zstd';

export interface StreamSettings {
  readonly ioBufferSize: number;
  readonly zipLevel: number;
  readonly veryRobustZip: boolean;
  readonly driver: 'zlib' | 'zstd';
  readonly asyncWriting: boolean;
  readonly flushIntervalSeconds: number;
  readonly sizeLimit: number;
  readonly sizeLimitCommand: string | null;
  readonly passFileName: boolean;
}

export interface StreamServices {
  open(): FileHandle | { readonly error: string };
  size(path: string): number | null;
  schedule(callback: () => void, delayMs: number): () => void;
  run(argv: readonly string[]): void;
  report(text: string, code: number): void;
}

interface Compressor {
  write(data: Uint8Array, flush: boolean): Uint8Array;
  finish(): Uint8Array;
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export class OmfileStream implements FileHandle {
  private handle: FileHandle | null;
  private buffer = '';
  private offset = 0;
  private compressor: Compressor | null = null;
  private cancelTimer: (() => void) | null = null;
  private closed = false;
  disabled = false;
  lastFailure: 'disabled' | 'no-size-limit-command' | null = null;

  constructor(
    readonly path: string,
    first: FileHandle,
    private readonly settings: StreamSettings,
    private readonly services: StreamServices,
    private readonly encryption: CryptoProvider | null = null,
    private encrypted: CryptoFile | null = null,
  ) {
    this.handle = first;
    this.offset = services.size(path) ?? 0;
  }

  private newCompressor(): Compressor | null {
    if (this.settings.zipLevel <= 0) return null;
    return this.settings.driver === 'zstd' ? new ZstdStreamWriter() : new GzipStreamWriter(Math.min(9, this.settings.zipLevel));
  }

  private ensureOpen(): string | null {
    if (this.handle !== null) return null;
    const opened = this.services.open();
    if ('error' in opened) return opened.error;
    if (this.encryption !== null) {
      const file = this.encryption.openFile(this.path, 'w');
      if ('error' in file) {
        opened.close();
        return file.error;
      }
      this.encrypted = file;
    }
    this.handle = opened;
    this.offset = this.services.size(this.path) ?? 0;
    return null;
  }

  private physicalWrite(text: string, flushCompressor: boolean): string | null {
    const failure = this.ensureOpen();
    if (failure !== null) return failure;
    let data = bytesOf(text);
    let binary = false;
    if (this.settings.zipLevel > 0) {
      this.compressor ??= this.newCompressor();
      const compressor = this.compressor as Compressor;
      let output = compressor.write(data, flushCompressor);
      if (this.settings.veryRobustZip) {
        const tail = compressor.finish();
        const joined = new Uint8Array(output.length + tail.length);
        joined.set(output, 0);
        joined.set(tail, output.length);
        output = joined;
        this.compressor = null;
      }
      data = output;
      binary = true;
    }
    if (this.encrypted !== null && data.length > 0) {
      data = this.encrypted.encrypt(data);
      binary = true;
    }
    const payload = binary ? bytesToFileText(data) : text;
    if (payload.length === 0) return null;
    const written = (this.handle as FileHandle).write(payload);
    if (written === null) this.offset += payload.length;
    return written;
  }

  private flushBuffer(flushCompressor: boolean): string | null {
    if (this.buffer.length === 0 || this.closed) return null;
    const text = this.buffer;
    this.buffer = '';
    return this.physicalWrite(text, flushCompressor);
  }

  private armTimer(): void {
    if (!this.settings.asyncWriting || this.cancelTimer !== null || this.buffer.length === 0) return;
    this.cancelTimer = this.services.schedule(() => {
      this.cancelTimer = null;
      this.flushBuffer(true);
    }, Math.max(0, this.settings.flushIntervalSeconds) * 1000);
  }

  write(text: string): string | null {
    if (this.closed) return 'stream closed';
    if (this.disabled) {
      this.lastFailure = 'disabled';
      return 'stream disabled';
    }
    this.lastFailure = null;
    let remaining = text;
    while (remaining.length > 0) {
      const room = this.settings.ioBufferSize - this.buffer.length;
      this.buffer += remaining.slice(0, room);
      remaining = remaining.slice(room);
      if (this.buffer.length >= this.settings.ioBufferSize) {
        const failure = this.flushBuffer(false);
        if (failure !== null) return failure;
      }
    }
    this.armTimer();
    if (this.handle !== null && this.settings.sizeLimit > 0) return this.processSizeLimit();
    return null;
  }

  flush(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.flushBuffer(true);
  }

  private closeFile(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.flushBuffer(true);
    if (this.compressor !== null) {
      const tail = this.compressor.finish();
      this.compressor = null;
      if (tail.length > 0) this.handle?.write(bytesToFileText(tail));
    }
    this.handle?.close();
    this.handle = null;
    this.encrypted?.close(this.offset);
    this.encrypted = null;
  }

  private processSizeLimit(): string | null {
    if (this.offset < this.settings.sizeLimit) return null;
    const name = this.path;
    this.closeFile();
    const command = this.settings.sizeLimitCommand;
    if (command === null) {
      this.lastFailure = 'no-size-limit-command';
      return 'size limit for file defined, but no size limit command given';
    }
    const space = command.indexOf(' ');
    const argv = space < 0 ? [command] : [command.slice(0, space), command.slice(space + 1)];
    if (this.settings.passFileName) argv.push(name);
    this.services.run(argv);
    const size = this.services.size(name);
    if (size !== null && size >= this.settings.sizeLimit) {
      this.services.report(`file size limit cmd for file '${name}' did no resolve situation\n`, RS_RET.ERR);
      this.disabled = true;
    }
    return null;
  }

  close(): void {
    this.closeFile();
    this.closed = true;
  }
}
