import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import type { CliSession } from '@/command-kernel/cli';
import { PushModeCommand } from '@/command-kernel/cli/commands/mode-transition';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `template` — transition de mode (push vers `radius-server-view`).
 * `prepare()` peut refuser la transition (retourner false après avoir
 * écrit un message sur ctx.io.stderr) ou positionner des promptFields
 * (ex: interface sélectionnée) avant le push.
 */
export class HuaweiRouterAaaRadiusServerTemplatePushCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'template',
    summary: 'Enter a RADIUS server template',
    usage: 'radius-server template <name>',
    args: [
      { name: 'rest', type: 'string', required: true, variadic: true, description: 'radius template tokens' },
    ],
    options: [],
    privileges: OP,
    category: 'cli-mode',
  };
  readonly allowedModes = ['aaa-view'];

    protected async prepare(ctx: CommandContext): Promise<boolean> {
    const value = ctx.args.get<string[]>('rest');
    if (!value || (Array.isArray(value) && value.length === 0)) {
      await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
      return false;
    }
    (ctx.session as CliSession).promptFields.set('selectedRadiusTemplate', Array.isArray(value) ? value.join(' ') : String(value));
    return true;
  }

  protected targetMode(_ctx: CommandContext): string {
    return 'radius-server-view';
  }
}
