import { bytesToUtf8 } from '@/crypto/encoding';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorView } from '@/network/devices/linux/editors/EditorView';
import type { ConnectionChannel, SshConnection } from '../connection/SshConnection';
import {
  COMPLETE_REQUEST, COMPLETE_RESULT_REQUEST, EDITOR_REQUEST, EDITOR_VIEW_REQUEST, LINE_RESULT_REQUEST,
  SHELL_INFO_REQUEST, STREAM_BEGIN_REQUEST, TTY_OP_ECHO, encodeTerminalModes,
  type EditorAction, type LineResultPayload, type ShellInfoPayload,
} from '../connection/SandboxExtensions';
import {
  decodeStringPayload, encodePtyRequest, encodeStringPayload, encodeWindowChange,
} from '../connection/ChannelPayloads';
import { AbstractSshChannel } from './AbstractSshChannel';
import type { ExecResult, ISshShellChannel } from './ISshChannel';

const TERMINAL_TYPE = 'xterm';
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

interface PendingLine {
  readonly resolve: (result: ExecResult) => void;
  chunks: Uint8Array[];
  streaming: boolean;
}

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const lineFeeds = (text: string): string => text.replace(/\r\n/g, '\n');

export class SshShellChannel
  extends AbstractSshChannel
  implements ISshShellChannel
{
  readonly type = 'shell' as const;

  private channel: ConnectionChannel | null = null;
  private dataHandlers: Array<(d: string) => void> = [];
  private cols = DEFAULT_COLUMNS;
  private rows = DEFAULT_ROWS;
  private pendingLine: PendingLine | null = null;
  private pendingComplete: ((c: string[]) => void) | null = null;
  private pendingEditor: ((v: EditorView | null) => void) | null = null;
  private inlineHelp = false;
  private openingPrompt: string | null = null;
  private openingMotd: string | null = null;
  private posix = true;
  private bannerBytesLeft = 0;

  constructor(private readonly connection: SshConnection, channelId: number) {
    super(channelId, 'shell');
  }

  supportsInlineHelp(): boolean { return this.inlineHelp; }

  initialPrompt(): string | null { return this.openingPrompt; }

  initialMotd(): string | null { return this.openingMotd; }

  isPosixShell(): boolean { return this.posix; }

  protected handleOpen(): void {
    const channel = this.connection.beginOpen('session');
    this.channel = channel;
    channel.onData((data) => this.receiveData(data));
    channel.onRequest((request) => this.receiveRequest(request.name, request.payload, request.reply));
    channel.onClose(() => {
      this.channel = null;
      if (channel.transportLost) this.lose();
      else this.close();
    });
    channel.whenOpened((failure) => {
      if (failure !== null) {
        this.close();
        return;
      }
      void channel.request('pty-req', encodePtyRequest({
        term: TERMINAL_TYPE, columns: this.cols, rows: this.rows, pixelWidth: 0, pixelHeight: 0,
        modes: encodeTerminalModes(new Map([[TTY_OP_ECHO, 0]])),
      }), true);
      void channel.request('shell', undefined, true);
    });
  }

  protected handleClose(): void {
    this.channel?.close();
    this.dataHandlers = [];
    const waiting = this.pendingLine;
    this.pendingLine = null;
    waiting?.resolve({ stdout: '', stderr: 'channel closed', exitCode: 255 });
  }

  send(data: string): void {
    if (!this._isOpen) return;
    void this.runLine(data);
  }

  onData(handler: (data: string) => void): () => void {
    this.dataHandlers.push(handler);
    return () => {
      this.dataHandlers = this.dataHandlers.filter((h) => h !== handler);
    };
  }

  runLine(line: string): Promise<ExecResult> {
    if (!this._isOpen || this.channel === null) {
      return Promise.resolve({ stdout: '', stderr: 'channel closed', exitCode: 255 });
    }
    const channel = this.channel;
    return new Promise<ExecResult>((resolve) => {
      this.pendingLine = { resolve, chunks: [], streaming: false };
      channel.write(`${line}\n`);
    });
  }

  provideInput(value: string): Promise<ExecResult> {
    return this.runLine(value);
  }

  complete(line: string): Promise<string[]> {
    if (!this._isOpen || this.channel === null) return Promise.resolve([]);
    const channel = this.channel;
    return new Promise<string[]>((resolve) => {
      this.pendingComplete = resolve;
      void channel.request(COMPLETE_REQUEST, encodeStringPayload(line), false);
    });
  }

  openEditor(commandLine: string): Promise<EditorView | null> {
    return this.editorExchange({ action: 'open', commandLine });
  }

  sendEditorKey(key: EditorKeyInput): Promise<EditorView | null> {
    return this.editorExchange({ action: 'key', key });
  }

  pasteIntoEditor(text: string): Promise<EditorView | null> {
    return this.editorExchange({ action: 'paste', text });
  }

  moveEditorCursor(offset: number): Promise<EditorView | null> {
    return this.editorExchange({ action: 'cursor', offset });
  }

  closeEditor(): void {
    if (!this._isOpen || this.channel === null) return;
    void this.channel.request(EDITOR_REQUEST, encodeStringPayload(JSON.stringify({ action: 'close' })), false);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this._isOpen && this.channel !== null) {
      void this.channel.request('window-change', encodeWindowChange({
        columns: cols, rows, pixelWidth: 0, pixelHeight: 0,
      }), false);
    }
  }

  sendSignal(signal: 'SIGINT'): void {
    if (!this._isOpen || this.channel === null) return;
    void this.channel.request('signal', encodeStringPayload(signal === 'SIGINT' ? 'INT' : signal), false);
  }

  getDimensions(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  private editorExchange(action: EditorAction): Promise<EditorView | null> {
    if (!this._isOpen || this.channel === null) return Promise.resolve(null);
    const channel = this.channel;
    return new Promise<EditorView | null>((resolve) => {
      this.pendingEditor = resolve;
      void channel.request(EDITOR_REQUEST, encodeStringPayload(JSON.stringify(action)), false);
    });
  }

  private emit(text: string): void {
    if (text === '') return;
    for (const handler of [...this.dataHandlers]) handler(text);
  }

  private receiveData(data: Uint8Array): void {
    let bytes = data;
    if (this.bannerBytesLeft > 0) {
      const skipped = Math.min(this.bannerBytesLeft, bytes.length);
      this.bannerBytesLeft -= skipped;
      bytes = bytes.subarray(skipped);
      if (bytes.length === 0) return;
    }
    const pending = this.pendingLine;
    if (pending === null) {
      this.emit(lineFeeds(bytesToUtf8(bytes)));
    } else if (pending.streaming) {
      this.emit(lineFeeds(bytesToUtf8(bytes)).replace(/\n$/, ''));
    } else {
      pending.chunks.push(bytes);
    }
  }

  private receiveRequest(name: string, payload: Uint8Array, reply: (success: boolean) => void): void {
    const text = decodeStringPayload(payload);
    switch (name) {
      case SHELL_INFO_REQUEST: {
        const info = JSON.parse(text ?? '{}') as ShellInfoPayload;
        this.inlineHelp = info.inlineHelp === true;
        this.openingPrompt = info.prompt;
        this.openingMotd = info.motd;
        this.posix = info.posixShell !== false;
        this.bannerBytesLeft = info.bannerBytes;
        return;
      }
      case STREAM_BEGIN_REQUEST:
        if (this.pendingLine !== null) this.pendingLine.streaming = true;
        return;
      case LINE_RESULT_REQUEST:
        this.finishLine(JSON.parse(text ?? '{}') as LineResultPayload);
        return;
      case COMPLETE_RESULT_REQUEST: {
        const parsed = JSON.parse(text ?? '[]') as unknown[];
        this.pendingComplete?.(parsed.filter((c): c is string => typeof c === 'string'));
        this.pendingComplete = null;
        return;
      }
      case EDITOR_VIEW_REQUEST: {
        const parsed = JSON.parse(text ?? '{}') as { view?: EditorView | null };
        this.pendingEditor?.(parsed.view ?? null);
        this.pendingEditor = null;
        return;
      }
      case 'exit-status':
      case 'exit-signal':
        return;
      default:
        reply(false);
    }
  }

  private finishLine(summary: LineResultPayload): void {
    const pending = this.pendingLine;
    this.pendingLine = null;
    if (pending === null) return;
    const bytes = joinBytes(pending.chunks);
    const stdout = lineFeeds(bytesToUtf8(bytes.subarray(0, summary.stdoutBytes)));
    const stderr = lineFeeds(bytesToUtf8(bytes.subarray(summary.stdoutBytes, summary.stdoutBytes + summary.stderrBytes)));
    const result: ExecResult = {
      stdout, stderr, exitCode: summary.exitCode,
      prompt: summary.prompt ?? undefined,
      nested: summary.nested,
      clearScreen: summary.clearScreen,
      pendingInput: summary.pendingInput ?? undefined,
      sessionEnded: summary.sessionEnded,
    };
    pending.resolve(result);
    this.emit(stdout + stderr);
  }
}
