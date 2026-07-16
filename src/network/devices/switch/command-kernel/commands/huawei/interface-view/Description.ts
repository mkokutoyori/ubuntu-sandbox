import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { SwitchMachineApi } from '../../../SwitchMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `description <text...>` (Huawei VRP switch, interface-view) — feuille
 * standalone. Capture le reste de la ligne comme description libre et
 * délègue à `SwitchMachineApi.switch.setInterfaceDescription`.
 */
export class HuaweiSwitchIfDescriptionCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'description',
    summary: 'Set the interface description',
    usage: 'description <text>',
    args: [{ name: 'text', type: 'string', required: true, variadic: true, description: 'Description text (may include spaces)' }],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['interface-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const iface = (ctx.session as CliSession).promptFields.get('selectedInterface');
    if (!iface) {
      await ctx.io.stderr.write('Error: No interface selected.\n');
      return 1;
    }
    const parts = ctx.args.get<string[]>('text') ?? [];
    if (parts.length === 0) {
      await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
      return 1;
    }
    if (!machine.switch.setInterfaceDescription(iface, parts.join(' '))) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
