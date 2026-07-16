import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../SwitchMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `sysname <name>` (Huawei VRP, mode system-view — switch) — équivalent
 * VRP de `hostname` chez Cisco. Miroir strict de la version routeur.
 * Modifie le hostname via `SwitchMachineApi.setHostname`. Silence VRP
 * en cas de succès ; message vendeur exact si le nom est invalide.
 */
export class HuaweiSwitchSysnameCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'sysname',
    summary: 'Specify the device host name',
    usage: 'sysname <name>',
    args: [{ name: 'name', type: 'string', required: true, description: 'Device host name' }],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['system-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const name = ctx.args.get<string>('name');
    if (!name || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return 1;
    }
    machine.setHostname(name);
    return EXIT_OK;
  }
}
