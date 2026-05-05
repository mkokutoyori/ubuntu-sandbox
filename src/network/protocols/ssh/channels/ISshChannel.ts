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
}

export interface ISshShellChannel extends ISshChannel {
  readonly type: 'shell';
  resize(cols: number, rows: number): void;
  send(data: string): void;
  onData(handler: (data: string) => void): () => void;
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
