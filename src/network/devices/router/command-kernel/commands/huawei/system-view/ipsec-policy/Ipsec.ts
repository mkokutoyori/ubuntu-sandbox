import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import type { CliSession } from '@/command-kernel/cli';
import { PushModeCommand } from '@/command-kernel/cli/commands/mode-transition';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

export class HuaweiRouterSysIpsecPolicyPushCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'policy',
    summary: 'Enter or create an IPSec policy',
    usage: 'policy <name> <seqno> {isakmp|manual}',
    args: [
      { name: 'rest', type: 'string', required: true, variadic: true, description: 'ipsec policy tokens' },
    ],
    options: [],
    privileges: OP,
    category: 'cli-mode',
  };
  readonly allowedModes = ['system-view'];

  protected async prepare(ctx: CommandContext): Promise<boolean> {
    const value = ctx.args.get<string[]>('rest') ?? [];
    if (value.length < 1) {
      await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
      return false;
    }
    (ctx.session as CliSession).promptFields.set('selectedIpsecPolicy', value.join(' '));
    return true;
  }

  protected targetMode(_ctx: CommandContext): string {
    return 'ipsec-policy-view';
  }
}
