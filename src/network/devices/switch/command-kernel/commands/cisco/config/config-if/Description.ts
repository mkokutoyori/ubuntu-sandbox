import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../SwitchMachineApi';
import { broadcastInterfaces } from './selected-interfaces';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** `description <text...>` (Cisco Catalyst, mode config-if) — attribue
 *  une description libre à l'interface sélectionnée. */
export class CiscoSwitchDescriptionCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'description',
    summary: 'Interface specific description',
    usage: 'description <text...>',
    args: [{ name: 'text', type: 'string', required: true, variadic: true, description: 'Interface description text' }],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const ifaces = broadcastInterfaces(ctx.session);
    if (ifaces.length === 0) { await ctx.io.stderr.write('% No interface selected.\n'); return 1; }
    const words = ctx.args.get<string[]>('text') ?? [];
    if (words.length === 0) { await ctx.io.stderr.write('% Incomplete command.\n'); return 1; }
    const text = words.join(' ');
    for (const iface of ifaces) {
      if (!machine.switch.setInterfaceDescription(iface, text)) {
        await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
        return 1;
      }
    }
    return EXIT_OK;
  }
}
