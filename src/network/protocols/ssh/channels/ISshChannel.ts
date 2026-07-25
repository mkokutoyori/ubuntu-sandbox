/**
 * SSH channel interfaces — Composite/Template Method base contracts.
 *
 * Reference: DESIGN-SSH-SFTP.md section 7.
 */

import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorView } from '@/network/devices/linux/editors/EditorView';

export type ChannelType = 'shell' | 'exec' | 'sftp';

export interface ISshChannel {
  readonly channelId: number;
  readonly type: ChannelType;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  /** Returns an unsubscribe handle. */
  onClose(handler: () => void): () => void;
}

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /**
   * The remote's prompt after this line ran, when the server publishes
   * one. Lets a client render the vendor's real prompt (`R1(config)#`,
   * `C:\Users\User>`) instead of guessing
   * (docs/PRD-SSH-Unification.md §3.1).
   */
  readonly prompt?: string;
  /**
   * True while a sub-shell (SQL*Plus, PowerShell, a future psql) owns
   * the channel's input on the server side. A client MUST NOT treat
   * `exit` as "close the SSH session" while this holds — the line
   * belongs to the nested interpreter, which pops itself
   * (docs/PRD-SSH-Unification.md §4bis B2).
   */
  readonly nested?: boolean;
}

export interface ISshShellChannel extends ISshChannel {
  readonly type: 'shell';
  resize(cols: number, rows: number): void;
  send(data: string): void;
  onData(handler: (data: string) => void): () => void;
  /**
   * Dispatch a single line of shell input to the server's persistent
   * shell session for this channel. Resolves with the captured output.
   * Server-side state (cwd, env) is preserved between calls. When the
   * line starts a real-time streaming job server-side (e.g. `ping`),
   * interim output arrives via `onData` before this promise resolves —
   * it only resolves once the job completes or is interrupted.
   */
  runLine(line: string): Promise<ExecResult>;
  /**
   * Ask the remote for Tab-completion candidates for a partial line.
   * Answered by the server's own shell, so the candidates reflect the
   * remote's commands, filesystem and CLI mode — never the client's.
   * Resolves to an empty list when the remote offers nothing
   * (docs/PRD-SSH-Unification.md §4bis B1).
   */
  complete(line: string): Promise<string[]>;
  /**
   * Ask the remote to open an editor for `commandLine`. Resolves with
   * the first screen when it did, or null when the line opens none (a
   * different command, or a remote with no editor engines). The engine
   * runs where the file is (docs/PRD-SSH-Unification.md §4bis B3).
   */
  openEditor(commandLine: string): Promise<EditorView | null>;
  /** Feed one keystroke to the open editor and get the fresh screen. */
  sendEditorKey(key: EditorKeyInput): Promise<EditorView | null>;
  /** Clipboard paste into the open editor. */
  pasteIntoEditor(text: string): Promise<EditorView | null>;
  /** Click-to-position inside the open editor, in rendered columns. */
  moveEditorCursor(offset: number): Promise<EditorView | null>;
  /** Abandon the editor session without waiting for its own exit key. */
  closeEditor(): void;
  /**
   * True when the remote treats `?` as a help key rather than an ordinary
   * character, so a client can offer inline help without breaking
   * `ls ?.txt` on a POSIX shell.
   */
  supportsInlineHelp(): boolean;
  /**
   * Send a signal to the channel's currently-running foreground job
   * (Ctrl+C ⇒ 'SIGINT'). No-op server-side if nothing is running.
   */
  sendSignal(signal: 'SIGINT'): void;
}

export interface ISshExecChannel extends ISshChannel {
  readonly type: 'exec';
  execute(): Promise<ExecResult>;
  readonly stdout: string;
  readonly exitCode: number;
}

export interface SftpRequest {
  readonly op: string;
  readonly [key: string]: unknown;
}

export interface SftpResponse {
  readonly ok: boolean;
  readonly [key: string]: unknown;
}

export interface ISshSftpChannel extends ISshChannel {
  readonly type: 'sftp';
  sendRequest(req: SftpRequest): SftpResponse;
  readonly remoteCwd: string;
}
