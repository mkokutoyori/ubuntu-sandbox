import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `preempt` — TODO: une ligne d'intention métier.
 * Commande feuille standalone : `ctx.machine` est l'unique source de données, formatage inline.
 */
export class CiscoRouterConfigIfStandbyPreemptCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'preempt',
    summary: 'HSRP preempt',
    usage: 'standby [group] preempt',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '[group]' },
    ],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config-if'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const rest = ctx.args.get<string[] | undefined>('rest');

    // TODO: lire UNIQUEMENT via la MachineApi ci-dessus, puis formater
    // chaque ligne de sortie inline (jamais de formateur legacy réutilisé).
    await ctx.io.stdout.write('TODO\n');
    return EXIT_OK;
  }
}
