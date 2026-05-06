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
  SftpChmodCommand,
  SftpChownCommand,
  SftpDfCommand,
  SftpGetCommand,
  SftpLsCommand,
  SftpMkdirCommand,
  SftpPutCommand,
  SftpRenameCommand,
  SftpRmCommand,
  SftpRmdirCommand,
  SftpStatCommand,
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
      new SftpVersionCommand(),
      new SftpDfCommand(),
    ]);
  }

  dispatch(
    op: string,
    req: SftpRequestPayload,
    ctx: SftpCommandContext,
  ): Result<unknown> {
    const cmd = this.registry.get(op);
    if (!cmd) return err({ kind: 'UNKNOWN_OP', op });
    return cmd.execute(req, ctx);
  }

  has(op: string): boolean {
    return this.registry.has(op);
  }
}
