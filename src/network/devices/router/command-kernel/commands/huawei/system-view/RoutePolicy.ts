import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import { PushModeCommand } from '@/command-kernel/cli/commands/mode-transition';
import type { CliSession } from '@/command-kernel/cli';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `route-policy` — transition de mode (push vers `route-policy-view`).
 * `prepare()` peut refuser la transition (retourner false après avoir
 * écrit un message sur ctx.io.stderr) ou positionner des promptFields
 * (ex: interface sélectionnée) avant le push.
 */
export class HuaweiRouterSysRoutePolicyCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'route-policy',
    summary: 'Enter or create a route-policy node',
    usage: 'route-policy <name> {permit|deny} node <n>',
    args: [
      { name: 'rest', type: 'string', required: true, variadic: true, description: 'route-policy tokens' },
    ],
    options: [],
    privileges: OP,
    category: 'cli-mode',
  };
  readonly allowedModes = ['system-view'];

  protected async prepare(ctx: CommandContext): Promise<boolean> {
    const rest = ctx.args.get<string[]>('rest') ?? [];
    if (rest.length < 1) {
      await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
      return false;
    }
    (ctx.session as CliSession).promptFields.set('selectedRoutePolicy', rest.join(' '));
    return true;
  }

  protected targetMode(_ctx: CommandContext): string {
    return 'route-policy-view';
  }
}
