import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import type { CliSession } from '@/command-kernel/cli';
import { PushModeCommand } from '@/command-kernel/cli/commands/mode-transition';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `proposal` — transition de mode (push vers `ike-proposal-view`).
 * `prepare()` peut refuser la transition (retourner false après avoir
 * écrit un message sur ctx.io.stderr) ou positionner des promptFields
 * (ex: interface sélectionnée) avant le push.
 */
export class HuaweiRouterSysIkeProposalCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'proposal',
    summary: 'Enter or create an IKE proposal',
    usage: 'ike proposal <id>',
    args: [
      { name: 'id', type: 'int', required: true, description: 'proposal id' },
    ],
    options: [],
    privileges: OP,
    category: 'cli-mode',
  };
  readonly allowedModes = ['system-view'];

  protected async prepare(ctx: CommandContext): Promise<boolean> {
    const id = ctx.args.get<number>('id');
    if (!Number.isInteger(id) || id < 1) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return false;
    }
    (ctx.session as CliSession).promptFields.set('selectedIkeProposal', String(id));
    return true;
  }

  protected targetMode(_ctx: CommandContext): string {
    return 'ike-proposal-view';
  }
}
