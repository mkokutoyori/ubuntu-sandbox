import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import type { CliSession } from '@/command-kernel/cli';
import { PushModeCommand } from '@/command-kernel/cli/commands/mode-transition';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `traffic-classifier` — transition de mode (push vers `traffic-classifier-view`).
 * `prepare()` peut refuser la transition (retourner false après avoir
 * écrit un message sur ctx.io.stderr) ou positionner des promptFields
 * (ex: interface sélectionnée) avant le push.
 */
export class HuaweiRouterSysTrafficClassifierCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'traffic-classifier',
    summary: 'Enter or create a traffic-classifier',
    usage: 'traffic classifier <name>',
    args: [
      { name: 'rest', type: 'string', required: true, variadic: true, description: 'classifier tokens' },
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
    (ctx.session as CliSession).promptFields.set('selectedTrafficClassifier', String(value));
    return true;
  }

  protected targetMode(_ctx: CommandContext): string {
    return 'traffic-classifier-view';
  }
}
