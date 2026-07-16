import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../SwitchMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `hostname <name>` (Cisco Catalyst, mode config) — miroir strict de la
 * commande routeur : même syntaxe Cisco (`[A-Za-z][A-Za-z0-9-]*`),
 * même silence en cas de succès, message vendeur si l'argument est
 * invalide.
 */
export class CiscoSwitchHostnameCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'hostname',
    summary: 'Set system\'s network name',
    usage: 'hostname <name>',
    args: [{ name: 'name', type: 'string', required: true, description: 'This system\'s network name' }],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const name = ctx.args.get<string>('name');
    if (!name || !/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    machine.setHostname(name);
    return EXIT_OK;
  }
}
