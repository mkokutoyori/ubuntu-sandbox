/**
 * SshSftpChannel — JSON-over-TCP SFTP channel.
 *
 * Synchronous request/response based on the simulator's invariant:
 * cable delivery is synchronous, so the server's response is received
 * inside `conn.write()`.
 *
 * Reference: DESIGN-SSH-SFTP.md section 7.
 */

import type { TcpStream as TcpConnection } from '@/network/core/TcpConnection';
import { AbstractSshChannel } from './AbstractSshChannel';
import type {
  ISshSftpChannel,
  SftpRequest,
  SftpResponse,
} from './ISshChannel';

export class SshSftpChannel
  extends AbstractSshChannel
  implements ISshSftpChannel
{
  readonly type = 'sftp' as const;

  private pendingResponse: SftpResponse | null = null;
  private offConn: (() => void) | null = null;
  private _remoteCwd = '/';

  constructor(conn: TcpConnection, channelId: number) {
    super(conn, channelId, 'sftp');
  }

  protected handleOpen(): void {
    this.offConn = this.conn.onData((data) => {
      try {
        this.pendingResponse = JSON.parse(data) as SftpResponse;
      } catch {
        this.pendingResponse = { ok: false, error: 'malformed response' };
      }
    });
  }

  protected handleClose(): void {
    this.offConn?.();
    this.offConn = null;
    this.pendingResponse = null;
  }

  sendRequest(req: SftpRequest): SftpResponse {
    if (!this._isOpen) {
      return { ok: false, error: 'channel not open' };
    }
    this.pendingResponse = null;
    this.conn.write(JSON.stringify({ ...req, channelId: this.channelId }));
    const response = this.pendingResponse ?? {
      ok: false,
      error: 'no response',
    };
    if (req.op === 'cd' && response.ok && typeof response.cwd === 'string') {
      this._remoteCwd = response.cwd;
    }
    return response;
  }

  get remoteCwd(): string {
    return this._remoteCwd;
  }
}
