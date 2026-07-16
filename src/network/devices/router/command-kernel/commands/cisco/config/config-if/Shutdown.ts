import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { RouterMachineApi } from '../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `shutdown` (Cisco IOS, mode config-if) — commande FEUILLE standalone.
 * Passe l'interface sélectionnée en admin-down. Silence Cisco à
 * l'exécution ; message vendeur si aucune interface n'est sélectionnée
 * (garde-fou : le mode config-if impose la sélection, ce chemin ne se
 * déclenche que si un appelant force une session incohérente).
 */
export class CiscoRouterShutdownCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'shutdown',
    summary: 'Shutdown the selected interface',
    usage: 'shutdown',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config-if'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const iface = (ctx.session as CliSession).promptFields.get('selectedInterface');
    if (!iface) {
      await ctx.io.stderr.write('% No interface selected.\n');
      return 1;
    }
    if (!machine.router.setInterfaceAdminUp(iface, false)) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
