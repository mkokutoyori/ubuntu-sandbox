import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import type { CliSession } from '@/command-kernel/cli';
import { PushModeCommand } from '@/command-kernel/cli/commands/mode-transition';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `area` — transition de mode (push vers `ospf-area-view`).
 * `prepare()` peut refuser la transition (retourner false après avoir
 * écrit un message sur ctx.io.stderr) ou positionner des promptFields
 * (ex: interface sélectionnée) avant le push.
 */
export class HuaweiRouterOspfAreaCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'area',
    summary: 'Enter or create an OSPF area',
    usage: 'area <id>',
    args: [
      { name: 'areaId', type: 'string', required: true, description: 'area id (decimal or A.B.C.D)' },
    ],
    options: [],
    privileges: OP,
    category: 'cli-mode',
  };
  readonly allowedModes = ['ospf-view'];

    protected async prepare(ctx: CommandContext): Promise<boolean> {
    const value = ctx.args.get<string>('areaId');
    if (value === undefined || value === null || value === '') {
      await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
      return false;
    }
    (ctx.session as CliSession).promptFields.set('selectedOspfArea', String(value));
    return true;
  }

  protected targetMode(_ctx: CommandContext): string {
    return 'ospf-area-view';
  }
}
