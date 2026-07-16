import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { SwitchMachineApi } from '../../../../SwitchMachineApi';

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
    const iface = (ctx.session as CliSession).promptFields.get('selectedInterface');
    if (!iface) { await ctx.io.stderr.write('% No interface selected.\n'); return 1; }
    const words = ctx.args.get<string[]>('text') ?? [];
    if (words.length === 0) { await ctx.io.stderr.write('% Incomplete command.\n'); return 1; }
    if (!machine.switch.setInterfaceDescription(iface, words.join(' '))) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
