import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import { PushModeCommand } from '@/command-kernel/cli/commands/mode-transition';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** `line {console 0|vty <lo> <hi>|aux 0}` (config) — push config-line. */
export class CiscoRouterConfigLineCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'line', summary: 'Configure a terminal line',
    usage: 'line {console 0|vty <lo> <hi>|aux 0}',
    args: [
      { name: 'type', type: 'string', required: true, description: 'Line type (console|vty|aux)' },
      { name: 'first', type: 'int', required: true, description: 'First line number' },
      { name: 'last', type: 'int', required: false, description: 'Last line number (vty only)' },
    ],
    options: [], privileges: OP, category: 'cli-mode',
  };
  readonly allowedModes = ['config'];

  protected async prepare(ctx: CommandContext): Promise<boolean> {
    const type = (ctx.args.get<string>('type') ?? '').toLowerCase();
    if (!['console', 'vty', 'aux'].includes(type)) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return false;
    }
    (ctx.session as CliSession).promptFields.set('lineType', type);
    return true;
  }

  protected targetMode(): string { return 'config-line'; }
}
