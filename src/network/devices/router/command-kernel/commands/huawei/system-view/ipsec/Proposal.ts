import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import type { CliSession } from '@/command-kernel/cli';
import { PushModeCommand } from '@/command-kernel/cli/commands/mode-transition';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `proposal` — transition de mode (push vers `ipsec-proposal-view`).
 * `prepare()` peut refuser la transition (retourner false après avoir
 * écrit un message sur ctx.io.stderr) ou positionner des promptFields
 * (ex: interface sélectionnée) avant le push.
 */
export class HuaweiRouterSysIpsecProposalCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'proposal',
    summary: 'Enter or create an IPSec transform-set (proposal)',
    usage: 'ipsec proposal <name>',
    args: [
      { name: 'name', type: 'string', required: true, description: 'proposal name' },
    ],
    options: [],
    privileges: OP,
    category: 'cli-mode',
  };
  readonly allowedModes = ['system-view'];

    protected async prepare(ctx: CommandContext): Promise<boolean> {
    const value = ctx.args.get<string>('name');
    if (value === undefined || value === null || value === '') {
      await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
      return false;
    }
    (ctx.session as CliSession).promptFields.set('selectedIpsecProposal', String(value));
    return true;
  }

  protected targetMode(_ctx: CommandContext): string {
    return 'ipsec-proposal-view';
  }
}
