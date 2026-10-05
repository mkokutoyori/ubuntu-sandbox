import { binaryStringToBytes, bytesToBinaryString } from '@/crypto/encoding';
import type { ConnectionChannel } from '../connection/SshConnection';
import type { ISftpFileSystem } from '../sftp/ISftpFileSystem';
import { decodeScpControlLine, encodeScpControlLine, scpModeString, SCP_ACK, type ScpControlLine } from './ScpWireCodec';

export interface ScpServerCommand {
  readonly role: 'sink' | 'source';
  readonly recursive: boolean;
  readonly preserveTimes: boolean;
  readonly targetMustBeDirectory: boolean;
  readonly path: string;
}

const SERVER_FLAGS = new Set(['-t', '-f', '-r', '-p', '-d', '-v']);

function unquote(word: string): string {
  if (word.length >= 2 && word.startsWith("'") && word.endsWith("'")) return word.slice(1, -1);
  if (word.length >= 2 && word.startsWith('"') && word.endsWith('"')) return word.slice(1, -1);
  return word.replace(/\\(.)/g, '$1');
}

export function parseScpServerCommand(command: string): ScpServerCommand | null {
  const words = command.trim().split(/\s+/);
  if (words[0] !== 'scp') return null;
  const flags: string[] = [];
  let index = 1;
  for (; index < words.length; index++) {
    if (words[index] === '--') { index++; break; }
    if (!words[index].startsWith('-')) break;
    for (const letter of words[index].slice(1)) flags.push(`-${letter}`);
  }
  const path = unquote(words.slice(index).join(' '));
  if (path === '' || flags.some((flag) => !SERVER_FLAGS.has(flag))) return null;
  const sink = flags.includes('-t');
  const source = flags.includes('-f');
  if (sink === source) return null;
  return {
    role: sink ? 'sink' : 'source',
    recursive: flags.includes('-r'),
    preserveTimes: flags.includes('-p'),
    targetMustBeDirectory: flags.includes('-d'),
    path,
  };
}

class ByteQueue {
  private queued = new Uint8Array(0);
  private waiting: { count: number | 'line'; resolve: (bytes: Uint8Array | null) => void } | null = null;
  private ended = false;

  push(bytes: Uint8Array): void {
    const merged = new Uint8Array(this.queued.length + bytes.length);
    merged.set(this.queued);
    merged.set(bytes, this.queued.length);
    this.queued = merged;
    this.settle();
  }

  end(): void {
    this.ended = true;
    this.settle();
  }

  take(count: number): Promise<Uint8Array | null> {
    return this.wait(count);
  }

  line(): Promise<Uint8Array | null> {
    return this.wait('line');
  }

  private wait(count: number | 'line'): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      this.waiting = { count, resolve };
      this.settle();
    });
  }

  private settle(): void {
    const pending = this.waiting;
    if (pending === null) return;
    if (pending.count === 'line') {
      const newline = this.queued.indexOf(0x0a);
      if (newline >= 0) {
        this.waiting = null;
        const line = this.queued.slice(0, newline + 1);
        this.queued = this.queued.slice(newline + 1);
        pending.resolve(line);
        return;
      }
    } else if (this.queued.length >= pending.count) {
      this.waiting = null;
      const taken = this.queued.slice(0, pending.count);
      this.queued = this.queued.slice(pending.count);
      pending.resolve(taken);
      return;
    }
    if (this.ended) {
      this.waiting = null;
      pending.resolve(null);
    }
  }
}

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

function joinPath(directory: string, name: string): string {
  return `${directory.replace(/\/+$/, '')}/${name}`;
}

export class ScpServerSession {
  private readonly inbound = new ByteQueue();

  constructor(
    private readonly channel: ConnectionChannel,
    private readonly fs: ISftpFileSystem,
    private readonly cwd: string,
    private readonly command: ScpServerCommand,
    private readonly finished: (exitCode: number) => void,
  ) {}

  start(): void {
    this.channel.onData((bytes) => this.inbound.push(bytes));
    this.channel.onEof(() => this.inbound.end());
    this.channel.onClose(() => this.inbound.end());
    const target = this.fs.normalizePath(this.command.path, this.cwd);
    const run = this.command.role === 'sink' ? this.sink(target) : this.source(target);
    void run.then((exitCode) => this.finished(exitCode));
  }

  private send(text: string): void {
    this.channel.write(binaryStringToBytes(text));
  }

  private acknowledge(): void {
    this.send('\x00');
  }

  private fail(message: string, fatal: boolean): void {
    this.send(`${String.fromCharCode(fatal ? SCP_ACK.FATAL : SCP_ACK.WARNING)}scp: ${message}\n`);
  }

  private async response(): Promise<{ ok: boolean; message: string } | null> {
    const first = await this.inbound.take(1);
    if (first === null) return null;
    if (first[0] === SCP_ACK.OK) return { ok: true, message: '' };
    const message = await this.inbound.line();
    return { ok: false, message: message === null ? '' : bytesToBinaryString(message).replace(/\n$/, '') };
  }

  private async sink(target: string): Promise<number> {
    const targetIsDirectory = this.fs.getEntryType(target) === 'directory';
    if (this.command.targetMustBeDirectory && !targetIsDirectory) {
      this.fail(`${this.command.path}: Not a directory`, true);
      return 1;
    }
    this.acknowledge();
    const directories: string[] = [];
    let exitCode = 0;
    for (;;) {
      const raw = await this.inbound.line();
      if (raw === null) return exitCode;
      const text = bytesToBinaryString(raw);
      if (text.startsWith('\x01') || text.startsWith('\x02')) return 1;
      if (text.startsWith('T')) {
        this.acknowledge();
        continue;
      }
      const control = decodeScpControlLine(text);
      if (control === null) {
        this.fail('protocol error: bad control record', true);
        return 1;
      }
      if (control.kind === 'E') {
        directories.pop();
        this.acknowledge();
        continue;
      }
      const parent = directories.length > 0 ? directories[directories.length - 1] : null;
      const destination = parent !== null
        ? joinPath(parent, control.name)
        : (targetIsDirectory ? joinPath(target, control.name) : target);
      if (control.kind === 'D') {
        const exists = this.fs.getEntryType(destination) === 'directory';
        const made = exists ? { ok: true } : this.fs.mkdir(destination);
        if (!made.ok) {
          this.fail(`${destination}: Permission denied`, false);
          exitCode = 1;
          directories.push(destination);
          this.acknowledge();
          continue;
        }
        this.fs.setPermissions(destination, parseInt(control.mode, 8));
        directories.push(destination);
        this.acknowledge();
        continue;
      }
      this.acknowledge();
      const data = await this.inbound.take(control.size ?? 0);
      const trailer = data === null ? null : await this.inbound.take(1);
      if (data === null || trailer === null) return 1;
      const written = this.fs.writeFile(destination, bytesToBinaryString(data));
      if (!written.ok) {
        this.fail(`${destination}: Permission denied`, false);
        exitCode = 1;
        continue;
      }
      this.fs.setPermissions(destination, parseInt(control.mode, 8));
      this.acknowledge();
    }
  }

  private async source(path: string): Promise<number> {
    const initial = await this.response();
    if (initial === null || !initial.ok) return 1;
    const type = this.fs.getEntryType(path);
    if (type === null) {
      this.fail(`${this.command.path}: No such file or directory`, false);
      return 1;
    }
    if (type === 'directory' && !this.command.recursive) {
      this.fail(`${this.command.path}: not a regular file`, false);
      return 1;
    }
    return (await this.sendEntry(path)) ? 0 : 1;
  }

  private async sendEntry(path: string): Promise<boolean> {
    const stat = this.fs.stat(path);
    if (!stat.ok) {
      this.fail(`${path}: No such file or directory`, false);
      return false;
    }
    const name = baseName(path);
    if (this.fs.getEntryType(path) === 'directory') {
      const listed = this.fs.listDirectory(path);
      if (!listed.ok) {
        this.fail(`${path}: Permission denied`, false);
        return false;
      }
      if (!await this.exchange({ kind: 'D', mode: scpModeString(stat.value.mode), name })) return false;
      let allSent = true;
      for (const entry of listed.value) {
        if (entry.name === '.' || entry.name === '..') continue;
        if (!await this.sendEntry(joinPath(path, entry.name))) allSent = false;
      }
      return await this.exchange({ kind: 'E', mode: '', name: '' }) && allSent;
    }
    const content = this.fs.readFile(path);
    if (!content.ok) {
      this.fail(`${path}: Permission denied`, false);
      return false;
    }
    if (!await this.exchange({ kind: 'C', mode: scpModeString(stat.value.mode), size: content.value.length, name })) {
      return false;
    }
    this.send(`${content.value}\x00`);
    const accepted = await this.response();
    return accepted !== null && accepted.ok;
  }

  private async exchange(line: ScpControlLine): Promise<boolean> {
    this.send(encodeScpControlLine(line));
    const accepted = await this.response();
    return accepted !== null && accepted.ok;
  }
}
