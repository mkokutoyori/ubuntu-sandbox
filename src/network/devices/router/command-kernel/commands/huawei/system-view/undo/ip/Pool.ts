import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `pool` — TODO: une ligne d'intention métier.
 * Commande feuille standalone : `ctx.machine` est l'unique source de données, formatage inline.
 */
export class HuaweiRouterUndoIpPoolCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'pool',
    summary: 'Delete a DHCP pool',
    usage: 'undo ip pool <name>',
    args: [
      { name: 'poolName', type: 'string', required: true, description: 'pool name' },
    ],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['system-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const name = ctx.args.get<string>('poolName');
    if (!machine.removeDhcpPool(name)) {
      await ctx.io.stderr.write("Error: The pool does not exist.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
