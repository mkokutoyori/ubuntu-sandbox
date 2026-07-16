import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { SwitchMachineApi } from '../../../../SwitchMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `name <text>` (Cisco Catalyst, mode config-vlan) — commande FEUILLE
 * standalone. Renomme le VLAN sélectionné (identifiant en
 * `session.promptFields['selectedVlan']`). Un seul mot autorisé côté
 * Cisco.
 */
export class CiscoSwitchVlanNameCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'name',
    summary: 'Ascii name of the VLAN',
    usage: 'name <ascii-name>',
    args: [{ name: 'text', type: 'string', required: true, description: 'VLAN name (single word)' }],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-vlan'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const raw = (ctx.session as CliSession).promptFields.get('selectedVlan');
    const id = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isInteger(id)) {
      await ctx.io.stderr.write('% No VLAN selected.\n');
      return 1;
    }
    const name = ctx.args.get<string>('text');
    if (!name) { await ctx.io.stderr.write('% Incomplete command.\n'); return 1; }
    const result = machine.switch.renameVlan(id, name);
    if (!result.ok) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
