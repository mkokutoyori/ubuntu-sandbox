/**
 * SSH channel interfaces — Composite/Template Method base contracts.
 *
 * Reference: DESIGN-SSH-SFTP.md section 7.
 */

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
