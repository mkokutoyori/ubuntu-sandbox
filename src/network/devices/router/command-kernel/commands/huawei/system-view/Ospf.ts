import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import type { CliSession } from '@/command-kernel/cli';
import { PushModeCommand } from '@/command-kernel/cli/commands/mode-transition';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `ospf` — transition de mode (push vers `ospf-view`).
 * `prepare()` peut refuser la transition (retourner false après avoir
 * écrit un message sur ctx.io.stderr) ou positionner des promptFields
 * (ex: interface sélectionnée) avant le push.
 */
export class HuaweiRouterSysOspfCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'ospf',
    summary: 'Enter or create an OSPF process',
    usage: 'ospf [<process-id>]',
    args: [
      { name: 'processId', type: 'int', required: false, description: 'process id (default 1)' },
    ],
    options: [],
    privileges: OP,
    category: 'cli-mode',
  };
  readonly allowedModes = ['system-view'];

    protected async prepare(ctx: CommandContext): Promise<boolean> {
    const value = ctx.args.get<number>('processId');
    if (value === undefined || value === null) {
      await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
      return false;
    }
    (ctx.session as CliSession).promptFields.set('selectedOspfProcess', String(value));
    return true;
  }

  protected targetMode(_ctx: CommandContext): string {
    return 'ospf-view';
  }
}
