/**
 * SshExecChannel — non-interactive command execution.
 *
 * Reference: DESIGN-SSH-SFTP.md section 7.
 */

import type { TcpStream as TcpConnection } from '@/network/tcp/types';
import { AbstractSshChannel } from './AbstractSshChannel';
import type { ExecResult, ISshExecChannel } from './ISshChannel';

export class SshExecChannel
  extends AbstractSshChannel
  implements ISshExecChannel
{
  readonly type = 'exec' as const;

  private offConn: (() => void) | null = null;
  private result: ExecResult | null = null;
  private resolveExec: ((r: ExecResult) => void) | null = null;

  constructor(
    conn: TcpConnection,
    channelId: number,
    private readonly command: string,
  ) {
    super(conn, channelId, 'exec');
  }

  protected handleOpen(): void {
    this.offConn = this.conn.onData((data) => {
      try {
        const parsed = JSON.parse(data) as ExecResult;
        this.result = parsed;
        this.resolveExec?.(parsed);
      } catch {
        // Non-JSON output: collect as stdout fragment.
        const partial: ExecResult = {
          stdout: (this.result?.stdout ?? '') + data,
          stderr: this.result?.stderr ?? '',
          exitCode: this.result?.exitCode ?? 0,
        };
        this.result = partial;
      }
    });
  }

  protected handleClose(): void {
    this.offConn?.();
    this.offConn = null;
  }

  run(): ExecResult | null {
    if (!this._isOpen) {
      throw new Error('SshExecChannel: cannot execute on closed channel');
    }
    this.conn.write(
      JSON.stringify({
        op: 'exec',
        command: this.command,
        channelId: this.channelId,
      }),
    );
    return this.result;
  }

  async execute(): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve) => {
      this.resolveExec = resolve;
      const immediate = this.run();
      if (immediate) resolve(immediate);
    });
  }

  get stdout(): string {
    return this.result?.stdout ?? '';
  }

  get exitCode(): number {
    return this.result?.exitCode ?? -1;
  }
}
