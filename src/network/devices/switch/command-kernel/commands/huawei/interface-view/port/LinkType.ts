import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { SwitchInterfaceMode, SwitchMachineApi } from '../../../../SwitchMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

const VRP_TO_MODE: Record<string, SwitchInterfaceMode> = {
  access: 'access',
  trunk: 'trunk',
  hybrid: 'hybrid',
  'dot1q-tunnel': 'dot1q-tunnel',
};

/**
 * `port link-type <access|trunk|hybrid|dot1q-tunnel>` (Huawei VRP
 * switch, interface-view) — feuille standalone. Change le mode L2 du
 * port sélectionné via `SwitchMachineApi.switch.setInterfaceMode`.
 * Refus vendeur si la valeur n'est pas reconnue.
 */
export class HuaweiSwitchPortLinkTypeCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'link-type',
    summary: 'Configure the port link type',
    usage: 'port link-type <access|trunk|hybrid|dot1q-tunnel>',
    args: [{ name: 'mode', type: 'string', required: true, description: 'Link type keyword' }],
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
    const raw = ctx.args.get<string>('mode').toLowerCase();
    const mode = VRP_TO_MODE[raw];
    if (!mode) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return 1;
    }
    if (!machine.switch.setInterfaceMode(iface, mode)) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
