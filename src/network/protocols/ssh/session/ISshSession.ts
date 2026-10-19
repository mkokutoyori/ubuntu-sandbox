/**
 * ISshSession — Facade exposed to higher layers (terminal, scp, sftp).
 *
 * Reference: DESIGN-SSH-SFTP.md section 6.
 */

import type { SftpChannelLaunch } from '../channels/SshSftpChannel';
import type {
  ExecChannelOptions,
  ISshExecChannel,
  ISshSftpChannel,
  ISshShellChannel,
} from '../channels/ISshChannel';
import type { Result } from '../Result';
import type { SshConnectOptions } from '../SshConnectOptions';
import type { SshConnectionInfo } from './ISshInteractionHandler';
import type { SshSessionState } from './SshSessionState';

export interface ISshSession {
  connect(opts: SshConnectOptions): Promise<Result<SshConnectionInfo>>;
  openShellChannel(options?: { readonly forwardAgent?: boolean }): Result<ISshShellChannel>;
  openExecChannel(command: string, options?: ExecChannelOptions): Result<ISshExecChannel>;
  openSftpChannel(launch?: SftpChannelLaunch): Result<ISshSftpChannel>;
  disconnect(): void;
  readonly state: SshSessionState;
  readonly isConnected: boolean;
}
