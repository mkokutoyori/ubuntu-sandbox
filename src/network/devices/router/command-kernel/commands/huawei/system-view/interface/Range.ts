import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import type { CliSession } from '@/command-kernel/cli';
import { PushModeCommand } from '@/command-kernel/cli/commands/mode-transition';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `range` — transition de mode (push vers `interface-view`).
 * `prepare()` peut refuser la transition (retourner false après avoir
 * écrit un message sur ctx.io.stderr) ou positionner des promptFields
 * (ex: interface sélectionnée) avant le push.
 */
export class HuaweiRouterInterfaceRangeCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'range',
    summary: 'Enter a range of interfaces (bulk config)',
    usage: 'interface range <name-list>',
    args: [
      { name: 'rest', type: 'string', required: true, variadic: true, description: 'range tokens' },
    ],
    options: [],
    privileges: OP,
    category: 'cli-mode',
  };
  readonly allowedModes = ['system-view'];

    protected async prepare(ctx: CommandContext): Promise<boolean> {
    const value = ctx.args.get<string[]>('rest');
    if (value === undefined || value === null) {
      await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
      return false;
    }
    (ctx.session as CliSession).promptFields.set('selectedInterface', String(value));
    return true;
  }

  protected targetMode(_ctx: CommandContext): string {
    return 'interface-view';
  }
}
