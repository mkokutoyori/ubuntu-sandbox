import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import type { CliSession } from '@/command-kernel/cli';
import { PushModeCommand } from '@/command-kernel/cli/commands/mode-transition';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `traffic-behavior` — transition de mode (push vers `traffic-behavior-view`).
 * `prepare()` peut refuser la transition (retourner false après avoir
 * écrit un message sur ctx.io.stderr) ou positionner des promptFields
 * (ex: interface sélectionnée) avant le push.
 */
export class HuaweiRouterSysTrafficBehaviorCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'traffic-behavior',
    summary: 'Enter or create a traffic-behavior',
    usage: 'traffic behavior <name>',
    args: [
      { name: 'rest', type: 'string', required: true, variadic: true, description: 'behavior tokens' },
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
    (ctx.session as CliSession).promptFields.set('selectedTrafficBehavior', String(value));
    return true;
  }

  protected targetMode(_ctx: CommandContext): string {
    return 'traffic-behavior-view';
  }
}
