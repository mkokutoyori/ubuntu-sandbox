/**
 * SftpCommandDispatcher — Open/Closed dispatch over registered ISftpCommand.
 *
 * Reference: DESIGN-SSH-SFTP.md section 8.2.
 */

import { type Result, err } from '../Result';
import type {
  ISftpCommand,
  SftpCommandContext,
  SftpRequestPayload,
} from './ISftpCommand';
import {
  SftpCdCommand,
  SftpChmodCommand,
  SftpChownCommand,
  SftpDfCommand,
  SftpGetCommand,
  SftpHardlinkCommand,
  SftpLsCommand,
  SftpMkdirCommand,
  SftpPutCommand,
  SftpPwdCommand,
  SftpReadlinkCommand,
  SftpRenameCommand,
  SftpRmCommand,
  SftpRmdirCommand,
  SftpStatCommand,
  SftpSymlinkCommand,
  SftpVersionCommand,
} from './SftpCommands';

export class SftpCommandDispatcher {
  private constructor(
    private readonly registry: ReadonlyMap<string, ISftpCommand>,
  ) {}

  static build(commands: readonly ISftpCommand[]): SftpCommandDispatcher {
    const map = new Map<string, ISftpCommand>();
    for (const c of commands) map.set(c.op, c);
    return new SftpCommandDispatcher(map);
  }

  /** Default registry covering all operations described in the design. */
  static defaults(): SftpCommandDispatcher {
    return SftpCommandDispatcher.build([
      new SftpGetCommand(),
      new SftpPutCommand(),
      new SftpLsCommand(),
      new SftpMkdirCommand(),
      new SftpRmCommand(),
      new SftpRmdirCommand(),
      new SftpRenameCommand(),
      new SftpChmodCommand(),
      new SftpChownCommand(),
      new SftpStatCommand(),
      new SftpSymlinkCommand(),
      new SftpReadlinkCommand(),
      new SftpHardlinkCommand(),
      new SftpVersionCommand(),
      new SftpDfCommand(),
      new SftpCdCommand(),
      new SftpPwdCommand(),
    ]);
  }

  dispatch(
    op: string,
    req: Omit<SftpRequestPayload, 'op'>,
    ctx: SftpCommandContext,
  ): Result<unknown> {
    const cmd = this.registry.get(op);
    if (!cmd) return err({ kind: 'UNKNOWN_OP', op });
    return cmd.execute({ ...req, op }, ctx);
  }

  has(op: string): boolean {
    return this.registry.has(op);
  }
}
