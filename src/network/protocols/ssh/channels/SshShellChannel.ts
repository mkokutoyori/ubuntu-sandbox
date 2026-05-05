/**
 * SshShellChannel — interactive shell channel.
 *
 * Reference: DESIGN-SSH-SFTP.md section 7.
 */

import type { TcpConnection } from '@/network/core/TcpConnection';
import { AbstractSshChannel } from './AbstractSshChannel';
import type { ISshShellChannel } from './ISshChannel';

export class SshShellChannel
  extends AbstractSshChannel
  implements ISshShellChannel
{
  readonly type = 'shell' as const;

  private dataHandlers: Array<(d: string) => void> = [];
  private offConn: (() => void) | null = null;
  private cols = 80;
  private rows = 24;

  constructor(conn: TcpConnection, channelId: number) {
    super(conn, channelId, 'shell');
  }

  protected handleOpen(): void {
    this.offConn = this.conn.onData((data) => {
      for (const h of this.dataHandlers) h(data);
    });
  }

  protected handleClose(): void {
    this.offConn?.();
    this.offConn = null;
    this.dataHandlers = [];
  }

  send(data: string): void {
    if (!this._isOpen) return;
    this.conn.write(data);
  }

  onData(handler: (data: string) => void): () => void {
    this.dataHandlers.push(handler);
    return () => {
      this.dataHandlers = this.dataHandlers.filter((h) => h !== handler);
    };
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this._isOpen) {
      this.conn.write(
        JSON.stringify({ op: 'resize', cols, rows, channelId: this.channelId }),
      );
    }
  }

  getDimensions(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }
}
