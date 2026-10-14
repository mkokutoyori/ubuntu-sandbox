import { binaryStringToBytes, bytesToBinaryString } from '@/crypto/encoding';
import type { ConnectionChannel } from '../connection/SshConnection';
import type { ISftpFileSystem } from '../sftp/ISftpFileSystem';
import { ScpByteQueue } from './ScpByteQueue';
import { scpProgressLine } from './ScpTransfer';
import { decodeScpControlLine, encodeScpControlLine, scpModeString, SCP_ACK } from './ScpWireCodec';

export interface ScpClientTransfer {
  readonly local: ISftpFileSystem;
  readonly localPath: string;
  readonly recursive: boolean;
  readonly preserve: boolean;
  readonly quiet: boolean;
}

export interface ScpClientResult {
  readonly ok: boolean;
  readonly lines: readonly string[];
  readonly error?: string;
}

const SOURCE_UMASK = 0o022;

interface Reply {
  readonly ok: boolean;
  readonly message: string;
  readonly foreign: boolean;
}

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

function joinPath(directory: string, name: string): string {
  return `${directory.replace(/\/+$/, '')}/${name}`;
}

class ScpClientWire {
  private readonly inbound = new ScpByteQueue();
  readonly lines: string[] = [];
  error: string | null = null;

  constructor(private readonly channel: ConnectionChannel, private readonly transfer: ScpClientTransfer) {
    channel.onData((bytes) => this.inbound.push(bytes));
    channel.onEof(() => this.inbound.end());
    channel.onClose(() => this.inbound.end());
  }

  send(text: string): void {
    this.channel.write(binaryStringToBytes(text));
  }

  line(): Promise<Uint8Array | null> {
    return this.inbound.line();
  }

  take(count: number): Promise<Uint8Array | null> {
    return this.inbound.take(count);
  }

  async reply(): Promise<Reply> {
    const first = await this.inbound.take(1);
    if (first === null) return { ok: false, message: 'Connection closed', foreign: false };
    if (first[0] === SCP_ACK.OK) return { ok: true, message: '', foreign: false };
    const rest = await this.inbound.line();
    const text = rest === null ? '' : bytesToBinaryString(rest).replace(/\n$/, '');
    if (first[0] === SCP_ACK.WARNING || first[0] === SCP_ACK.FATAL) {
      return { ok: false, message: text, foreign: false };
    }
    return { ok: false, message: `${String.fromCharCode(first[0])}${text}`, foreign: true };
  }

  fail(reply: Reply): false {
    this.error = reply.foreign ? `${reply.message}\nscp: Connection closed` : reply.message.startsWith('scp: ') ? reply.message : `scp: ${reply.message}`;
    return false;
  }

  progress(name: string, bytes: number): void {
    if (!this.transfer.quiet) this.lines.push(scpProgressLine(name, bytes));
  }

  finish(): ScpClientResult {
    this.channel.close();
    return { ok: this.error === null, lines: this.lines, ...(this.error === null ? {} : { error: this.error }) };
  }
}

async function sendEntry(wire: ScpClientWire, transfer: ScpClientTransfer, path: string): Promise<boolean> {
  const stat = transfer.local.stat(path);
  if (!stat.ok) {
    wire.error = `scp: ${path}: No such file or directory`;
    return false;
  }
  const name = baseName(path);
  const acknowledged = async (): Promise<boolean> => {
    const reply = await wire.reply();
    return reply.ok || wire.fail(reply);
  };
  if (transfer.preserve) {
    wire.send(`T${Math.floor(stat.value.mtime)} 0 ${Math.floor(stat.value.mtime)} 0\n`);
    if (!await acknowledged()) return false;
  }
  if (transfer.local.getEntryType(path) === 'directory') {
    const listed = transfer.local.listDirectory(path);
    if (!listed.ok) {
      wire.error = `scp: ${path}: Permission denied`;
      return false;
    }
    wire.send(encodeScpControlLine({ kind: 'D', mode: scpModeString(stat.value.mode), name }));
    if (!await acknowledged()) return false;
    for (const entry of listed.value) {
      if (entry.name === '.' || entry.name === '..') continue;
      if (!await sendEntry(wire, transfer, joinPath(path, entry.name))) return false;
    }
    wire.send(encodeScpControlLine({ kind: 'E', mode: '', name: '' }));
    return acknowledged();
  }
  const content = transfer.local.readFile(path);
  if (!content.ok) {
    wire.error = `scp: ${path}: Permission denied`;
    return false;
  }
  wire.send(encodeScpControlLine({ kind: 'C', mode: scpModeString(stat.value.mode), size: content.value.length, name }));
  if (!await acknowledged()) return false;
  wire.send(`${content.value}\x00`);
  if (!await acknowledged()) return false;
  wire.progress(name, content.value.length);
  return true;
}

export async function scpUpload(channel: ConnectionChannel, transfer: ScpClientTransfer): Promise<ScpClientResult> {
  const wire = new ScpClientWire(channel, transfer);
  const first = await wire.reply();
  if (!first.ok) {
    wire.fail(first);
    return wire.finish();
  }
  const type = transfer.local.getEntryType(transfer.localPath);
  if (type === null) wire.error = `scp: ${transfer.localPath}: No such file or directory`;
  else if (type === 'directory' && !transfer.recursive) wire.error = `scp: ${transfer.localPath}: not a regular file`;
  else await sendEntry(wire, transfer, transfer.localPath);
  return wire.finish();
}

export async function scpDownload(channel: ConnectionChannel, transfer: ScpClientTransfer): Promise<ScpClientResult> {
  const wire = new ScpClientWire(channel, transfer);
  const target = transfer.localPath;
  const targetIsDirectory = transfer.local.getEntryType(target) === 'directory';
  const directories: string[] = [];
  wire.send('\x00');
  for (;;) {
    const raw = await wire.line();
    if (raw === null) break;
    const text = bytesToBinaryString(raw);
    const marker = text.charCodeAt(0);
    if (marker === SCP_ACK.WARNING || marker === SCP_ACK.FATAL) {
      wire.error = text.slice(1).replace(/\n$/, '');
      break;
    }
    if (text.startsWith('T')) {
      wire.send('\x00');
      continue;
    }
    const control = decodeScpControlLine(text);
    if (control === null) {
      wire.error = `${text.replace(/\n$/, '')}\nscp: Connection closed`;
      break;
    }
    if (control.kind === 'E') {
      directories.pop();
      wire.send('\x00');
      continue;
    }
    const parent = directories.length > 0 ? directories[directories.length - 1] : null;
    const destination = parent !== null
      ? joinPath(parent, control.name)
      : (targetIsDirectory ? joinPath(target, control.name) : target);
    if (control.kind === 'D') {
      if (transfer.local.getEntryType(destination) !== 'directory') transfer.local.mkdir(destination);
      transfer.local.setPermissions(destination, transfer.preserve ? parseInt(control.mode, 8) : parseInt(control.mode, 8) & ~SOURCE_UMASK);
      directories.push(destination);
      wire.send('\x00');
      continue;
    }
    wire.send('\x00');
    const data = await wire.take(control.size ?? 0);
    const trailer = data === null ? null : await wire.take(1);
    if (data === null || trailer === null) {
      wire.error = 'scp: Connection closed';
      break;
    }
    const written = transfer.local.writeFile(destination, bytesToBinaryString(data));
    if (!written.ok) {
      wire.error = `scp: ${destination}: Permission denied`;
      break;
    }
    transfer.local.setPermissions(destination, transfer.preserve ? parseInt(control.mode, 8) : parseInt(control.mode, 8) & ~SOURCE_UMASK);
    wire.progress(control.name, data.length);
    wire.send('\x00');
  }
  return wire.finish();
}
