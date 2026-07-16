import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `sysname <name>` (Huawei VRP, mode system-view) — équivalent VRP de
 * `hostname` chez Cisco. Modifie le hostname via
 * `RouterMachineApi.setHostname`. Silence VRP en cas de succès ; message
 * vendeur exact si le nom est invalide. Le prompt se met à jour au
 * prochain `getPrompt()`.
 */
export class HuaweiRouterSysnameCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'sysname',
    summary: 'Specify the device host name',
    usage: 'sysname <name>',
    args: [{ name: 'name', type: 'string', required: true, description: 'Device host name' }],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['system-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const name = ctx.args.get<string>('name');
    if (!name || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return 1;
    }
    machine.setHostname(name);
    return EXIT_OK;
  }
}
