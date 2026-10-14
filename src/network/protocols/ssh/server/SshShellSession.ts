import { simulationNowMs } from '@/network/core/SystemClock';

import { bytesToUtf8, utf8ToBytes } from '@/crypto/encoding';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorSession, EditorView } from '@/network/devices/linux/editors/EditorView';
import type { EditorRelay } from '@/shell/SubShellStack';
import type { ChannelRequest, ConnectionChannel } from '../connection/SshConnection';
import {
  COMPLETE_REQUEST, COMPLETE_RESULT_REQUEST, EDITOR_REQUEST, EDITOR_VIEW_REQUEST, LINE_RESULT_REQUEST,
  SHELL_INFO_REQUEST, STREAM_BEGIN_REQUEST, TTY_OP_ECHO, TTY_OP_ONLCR, parseTerminalModes,
  type EditorAction, type LineResultPayload, type ShellInfoPayload,
} from '../connection/SandboxExtensions';
import { decodeStringPayload, decodeWindowChange, encodeExitStatus, encodeStringPayload, type PtyRequestPayload } from '../connection/ChannelPayloads';
import type { SshUserContext } from '../SshUserContext';
import type { ILinuxShell } from './ISshServerContext';
import type { SshInteractiveShell } from './SshInteractiveShell';

const CTRL_C = '\x03';
const CTRL_D = '\x04';
const BACKSPACE = '\x7f';
const BACKSPACE_ALT = '\x08';
const DEFAULT_ROWS = 24;
const DEFAULT_COLUMNS = 80;

export interface ShellSessionServices {
  readonly shell: ILinuxShell;
  readonly interactive: SshInteractiveShell | null;
  readonly motd: string;
  readonly user: SshUserContext;
  rearmIdle(): void;
  opened(): void;
  closed(durationMs: number): void;
}

function endedLine(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
}

export class SshShellSession {
  private readonly echo: boolean;
  private readonly newlineTranslation: boolean;
  private lineBuffer = '';
  private afterCarriageReturn = false;
  private busy = false;
  private readonly queue: string[] = [];
  private pendingInput = false;
  private editor: EditorSession | null = null;
  private relay: EditorRelay | null = null;
  private relayTurn: Promise<void> = Promise.resolve();
  private stopRelayViews: (() => void) | null = null;
  private streamAnnounced = false;
  private readonly heldAsync: string[] = [];
  private offAsync: (() => void) | null = null;
  private readonly startedAt = simulationNowMs();
  private disposed = false;
  private endOfInput = false;
  private rows: number;
  private cols: number;
  private readonly hasPty: boolean;

  constructor(
    private readonly channel: ConnectionChannel,
    pty: PtyRequestPayload | null,
    private readonly services: ShellSessionServices,
  ) {
    this.hasPty = pty !== null;
    this.rows = pty !== null && pty.rows > 0 ? pty.rows : DEFAULT_ROWS;
    this.cols = pty !== null && pty.columns > 0 ? pty.columns : DEFAULT_COLUMNS;
    const modes = pty === null ? new Map<number, number>() : parseTerminalModes(pty.modes);
    this.echo = pty !== null && (modes.get(TTY_OP_ECHO) ?? 1) !== 0;
    this.newlineTranslation = pty !== null && (modes.get(TTY_OP_ONLCR) ?? 1) !== 0;
  }

  start(): void {
    const { shell, motd } = this.services;
    this.offAsync = shell.subscribeAsyncOutput?.((text) => {
      const line = text.endsWith('\n') ? text : `${text}\n`;
      if (this.busy) this.heldAsync.push(line);
      else this.writeText(line);
    }) ?? null;
    if (this.hasPty) shell.setWindowSize?.(this.rows, this.cols);
    this.services.opened();
    this.services.rearmIdle();
    const prompt = shell.getPrompt?.() ?? null;
    const motdText = motd === '' || motd.endsWith('\n') ? motd : `${motd}\n`;
    const banner = `${this.translate(motdText)}${prompt ?? ''}`;
    const info: ShellInfoPayload = {
      inlineHelp: shell.supportsInlineHelp === true,
      prompt,
      posixShell: shell.posixShell !== false,
      shellKind: shell.loginShellKind ?? null,
      motd,
      bannerBytes: utf8ToBytes(banner).length,
    };
    void this.channel.request(SHELL_INFO_REQUEST, encodeStringPayload(JSON.stringify(info)), false);
    this.channel.write(banner);
    this.channel.onData((data) => this.receive(bytesToUtf8(data)));
    this.channel.onEof(() => {
      this.endOfInput = true;
      if (!this.busy && this.queue.length === 0) this.finish(0);
    });
    this.channel.onClose(() => this.dispose());
  }

  signal(name: string): void {
    if (name === 'INT') {
      if (this.services.shell.interrupt?.() === true) return;
      this.services.interactive?.interruptForeground();
    }
  }

  handleRequest(request: ChannelRequest): void {
    const { name, payload } = request;
    const reply = (success: boolean): void => request.reply(success);
    switch (name) {
      case 'signal': {
        const signal = decodeStringPayload(payload);
        if (signal !== null) this.signal(signal);
        reply(true);
        return;
      }
      case 'window-change': {
        const change = decodeWindowChange(payload);
        if (change !== null) this.windowChanged(change.rows, change.columns);
        reply(true);
        return;
      }
      case COMPLETE_REQUEST: {
        const line = decodeStringPayload(payload) ?? '';
        const shell = this.services.shell;
        void (async () => {
          const candidates = (await shell.getCompletionsAsync?.(line)) ?? shell.getCompletions?.(line) ?? [];
          void this.channel.request(COMPLETE_RESULT_REQUEST, encodeStringPayload(JSON.stringify(candidates)), false);
        })();
        reply(true);
        return;
      }
      case EDITOR_REQUEST: {
        const text = decodeStringPayload(payload);
        if (text !== null) this.editorAction(JSON.parse(text) as EditorAction);
        reply(true);
        return;
      }
      default:
        reply(false);
    }
  }

  private windowChanged(rows: number, cols: number): void {
    if (rows < 1 || cols < 1) return;
    this.rows = rows;
    this.cols = cols;
    this.services.shell.setWindowSize?.(rows, cols);
    const view = this.editor?.resize?.(rows, cols) ?? null;
    if (view !== null) {
      void this.channel.request(EDITOR_VIEW_REQUEST, encodeStringPayload(JSON.stringify({ view, unsolicited: true })), false);
    }
  }

  private editorAction(action: EditorAction): void {
    const relay = action.action === 'open' ? this.services.shell.editorRelay?.() ?? null : this.relay;
    if (relay !== null) {
      this.relayTurn = this.relayTurn.then(() => this.relayEditorAction(relay, action));
      return;
    }
    let view: unknown = null;
    if (action.action === 'open') {
      this.editor = this.services.shell.openEditor?.(action.commandLine) ?? null;
      view = this.editor ? (this.editor.resize?.(this.rows, this.cols) ?? this.editor.view) : null;
    } else if (action.action === 'scroll') {
      view = this.editor?.scroll?.(action.up, action.count) ?? null;
    } else if (action.action === 'key') {
      if (this.editor) {
        const result = this.editor.applyKey(action.key as EditorKeyInput);
        if (result.exited) this.editor = null;
        view = result;
      }
    } else if (action.action === 'paste') {
      view = this.editor?.applyPaste?.(action.text) ?? null;
    } else if (action.action === 'click') {
      view = this.editor?.click?.(action.row, action.col) ?? null;
    } else {
      this.editor?.close();
      this.editor = null;
      return;
    }
    void this.channel.request(EDITOR_VIEW_REQUEST, encodeStringPayload(JSON.stringify({ view })), false);
  }

  private async relayEditorAction(relay: EditorRelay, action: EditorAction): Promise<void> {
    if (this.disposed) return;
    let view: EditorView | null = null;
    switch (action.action) {
      case 'open':
        view = await relay.open(action.commandLine);
        if (view !== null) {
          this.relay = relay;
          this.stopRelayViews = relay.transport.onEditorView((pushed) => {
            void this.channel.request(
              EDITOR_VIEW_REQUEST, encodeStringPayload(JSON.stringify({ view: pushed, unsolicited: true })), false);
          });
        }
        break;
      case 'key':
        view = await relay.transport.sendEditorKey(action.key as EditorKeyInput);
        break;
      case 'paste':
        view = await relay.transport.pasteIntoEditor(action.text);
        break;
      case 'click':
        view = await relay.transport.clickEditor(action.row, action.col);
        break;
      case 'scroll':
        view = await relay.transport.scrollEditor(action.up, action.count);
        break;
      default:
        this.releaseRelay();
        return;
    }
    if (view?.exited === true) this.releaseRelay(false);
    void this.channel.request(EDITOR_VIEW_REQUEST, encodeStringPayload(JSON.stringify({ view })), false);
  }

  private releaseRelay(closeRemote = true): void {
    if (closeRemote) this.relay?.transport.closeEditor();
    this.stopRelayViews?.();
    this.stopRelayViews = null;
    this.relay = null;
  }

  private receive(text: string): void {
    for (const char of text) {
      if (this.afterCarriageReturn && char === '\n') {
        this.afterCarriageReturn = false;
        continue;
      }
      this.afterCarriageReturn = char === '\r';
      if (char === '\r' || char === '\n') {
        this.echoText('\r\n');
        const line = this.lineBuffer;
        this.lineBuffer = '';
        this.submit(line);
      } else if (char === CTRL_C) {
        this.echoText('^C\r\n');
        this.lineBuffer = '';
        this.signal('INT');
      } else if (char === CTRL_D) {
        if (this.lineBuffer === '' && this.services.shell.posixShell !== false) this.finish(0);
      } else if (char === BACKSPACE || char === BACKSPACE_ALT) {
        if (this.lineBuffer.length > 0) {
          this.lineBuffer = this.lineBuffer.slice(0, -1);
          this.echoText('\b \b');
        }
      } else {
        this.lineBuffer += char;
        this.echoText(char);
      }
    }
  }

  private echoText(text: string): void {
    if (this.echo && !this.pendingInput) this.channel.write(text);
  }

  private submit(line: string): void {
    this.queue.push(line);
    this.drain();
  }

  private drain(): void {
    if (this.busy || this.disposed) return;
    const line = this.queue.shift();
    if (line === undefined) return;
    this.busy = true;
    this.services.rearmIdle();
    const wasPending = this.pendingInput;
    this.pendingInput = false;
    if (!wasPending) {
      const started = this.services.interactive?.tryStartStreaming(line, {
        onChunk: (text) => this.streamChunk(text),
        onDone: () => this.complete({ stdout: '', stderr: '', exitCode: 0 }),
        session: this.services.shell.isNested?.() === true ? undefined : this.services.shell.streamSession,
      }) ?? false;
      if (started) return;
    }
    const run = wasPending && this.services.shell.provideInput
      ? this.services.shell.provideInput(line)
      : this.services.shell.execute(line, (text) => this.streamChunk(text));
    void run.then((result) => this.complete(result));
  }

  private streamChunk(text: string): void {
    if (!this.streamAnnounced) {
      this.streamAnnounced = true;
      void this.channel.request(STREAM_BEGIN_REQUEST, undefined, false);
    }
    this.writeText(`${text}\n`);
  }

  private complete(result: {
    stdout: string; stderr: string; exitCode: number; clearScreen?: boolean;
    pendingInput?: { kind: 'password' | 'text'; promptText: string }; sessionEnded?: boolean;
  }): void {
    if (this.disposed) return;
    this.streamAnnounced = false;
    const stdout = this.translate(endedLine(result.stdout));
    const stderr = this.translate(endedLine(result.stderr));
    const prompt = this.services.shell.getPrompt?.() ?? null;
    const nested = this.services.shell.isNested?.() ?? false;
    const pendingInput = result.pendingInput ?? null;
    this.channel.write(stdout);
    this.channel.write(stderr);
    const summary: LineResultPayload = {
      stdoutBytes: utf8ToBytes(stdout).length,
      stderrBytes: utf8ToBytes(stderr).length,
      exitCode: result.exitCode,
      prompt, nested,
      clearScreen: result.clearScreen === true,
      pendingInput,
      sessionEnded: result.sessionEnded === true,
    };
    if (result.sessionEnded === true) {
      void this.channel.request(LINE_RESULT_REQUEST, encodeStringPayload(JSON.stringify(summary)), false);
      this.busy = false;
      this.finish(result.exitCode);
      return;
    }
    if (result.clearScreen === true) this.channel.write('\x1b[H\x1b[2J');
    if (pendingInput !== null) {
      this.pendingInput = true;
      this.channel.write(pendingInput.promptText);
    } else if (prompt !== null) {
      this.channel.write(prompt);
    }
    void this.channel.request(LINE_RESULT_REQUEST, encodeStringPayload(JSON.stringify(summary)), false);
    this.busy = false;
    for (const held of this.heldAsync.splice(0)) this.writeText(held);
    this.drain();
    if (this.endOfInput && !this.busy && this.queue.length === 0) this.finish(result.exitCode);
  }

  private writeText(text: string): void {
    this.channel.write(this.translate(text));
  }

  private translate(text: string): string {
    return this.newlineTranslation ? text.replace(/\r?\n/g, '\r\n') : text;
  }

  private finish(exitCode: number): void {
    void this.channel.request('exit-status', encodeExitStatus(exitCode), false);
    this.channel.eof();
    this.channel.close();
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offAsync?.();
    this.editor?.close();
    this.releaseRelay();
    this.services.interactive?.dispose();
    this.services.shell.dispose?.();
    this.services.closed(simulationNowMs() - this.startedAt);
  }
}
