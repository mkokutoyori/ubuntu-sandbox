import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { SwitchMachineApi } from '../../../../../../SwitchMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** `switchport mode access` (Cisco Catalyst, config-if) — feuille. */
export class CiscoSwitchModeAccessCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'access',
    summary: 'Set trunking mode to ACCESS unconditionally',
    usage: 'switchport mode access',
    args: [], options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const iface = (ctx.session as CliSession).promptFields.get('selectedInterface');
    if (!iface) { await ctx.io.stderr.write('% No interface selected.\n'); return 1; }
    if (!machine.switch.setInterfaceMode(iface, 'access')) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
