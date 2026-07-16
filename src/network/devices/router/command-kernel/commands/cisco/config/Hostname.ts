import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `hostname <name>` (Cisco IOS, mode config) — commande FEUILLE
 * standalone. Modifie le hostname via `RouterMachineApi.setHostname`.
 * Silence Cisco : aucune sortie en cas de succès, message vendeur seul
 * si l'argument est invalide. Le prompt se met à jour au prochain
 * `getPrompt()`.
 */
export class CiscoRouterHostnameCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'hostname',
    summary: 'Set system\'s network name',
    usage: 'hostname <name>',
    args: [{ name: 'name', type: 'string', required: true, description: 'This system\'s network name' }],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const name = ctx.args.get<string>('name');
    if (!name || !/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    machine.setHostname(name);
    return EXIT_OK;
  }
}
