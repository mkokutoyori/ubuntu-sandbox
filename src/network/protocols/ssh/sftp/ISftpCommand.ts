/**
 * ISftpCommand — Command Pattern for individual SFTP operations.
 *
 * Reference: DESIGN-SSH-SFTP.md section 8.2.
 */

import type { Result } from '../Result';
import type { SshUserContext } from '../SshUserContext';
import type { ISftpFileSystem } from './ISftpFileSystem';

export interface SftpCommandContext {
  readonly vfs: ISftpFileSystem;
  readonly userCtx: SshUserContext;
  readonly cwd: string;
}

export interface SftpRequestPayload {
  readonly op: string;
  readonly path?: string;
  readonly content?: string;
  readonly src?: string;
  readonly dst?: string;
  readonly mode?: number;
  readonly uid?: number;
  readonly gid?: number;
}

export interface ISftpCommand<T = unknown> {
  readonly op: string;
  execute(req: SftpRequestPayload, ctx: SftpCommandContext): Result<T>;
}
